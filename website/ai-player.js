/*
  Codenames AI Player Module
  - Nebius Token Factory LLM integration
  - Two modes: AI Helper (chat only) & AI Autonomous (full player)
  - Structured outputs for clues/guesses
  - Natural language team chat
  - Ready-up verification (colorless -> red/yellow/green)
*/

// ── Nebius API Configuration ──
const NEBIUS_BASE_URL = 'https://api.tokenfactory.nebius.com/v1';
const NEBIUS_API_KEY = 'v1.CmQKHHN0YXRpY2tleS1lMDBlbnJtZjJucHZic3FqY3ASIXNlcnZpY2VhY2NvdW50LWUwMGtkN3BmbjR5NmZ2Y2U5MjIMCPWs7MsGEOnjmtYCOgwI9K-ElwcQwKSajQNAAloDZTAw.AAAAAAAAAAG8btw7VVpjy-ijvLwCIyDss74-lzEn16V8puwNgQE3K9XBwgT656Vs_UT7fVpX4_kC_UYNAzQz3XjLy6QXJM8C';
const NEBIUS_MODEL = 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B';

// ── Structured Output Schemas ──
const SPYMASTER_CLUE_SCHEMA = {
  type: 'json_schema',
  json_schema: {
    name: 'spymaster_clue',
    schema: {
      type: 'object',
      properties: {
        clue: { type: 'string', description: 'A single-word clue (no spaces, not a word on the board)' },
        number: { type: 'integer', minimum: 0, maximum: 9, description: 'How many cards this clue relates to' }
      },
      required: ['clue', 'number']
    }
  }
};

const OPERATIVE_GUESS_SCHEMA = {
  type: 'json_schema',
  json_schema: {
    name: 'operative_guess',
    schema: {
      type: 'object',
      properties: {
        cardWord: { type: 'string', description: 'The exact word on the card to guess' },
        confidence: { type: 'number', description: 'Confidence level from 0.0 to 1.0' },
        reasoning: { type: 'string', description: 'Brief explanation of why this card was chosen' }
      },
      required: ['cardWord', 'confidence', 'reasoning']
    }
  }
};

// ── Nebius API Wrapper ──
async function nebiusChat(messages, options = {}) {
  const body = {
    model: NEBIUS_MODEL,
    messages,
  };
  if (options.responseFormat) {
    body.response_format = options.responseFormat;
  }
  if (options.temperature !== undefined) {
    body.temperature = options.temperature;
  }

  const resp = await fetch(`${NEBIUS_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${NEBIUS_API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`Nebius API error ${resp.status}: ${errText}`);
  }

  const data = await resp.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('No content in Nebius response');
  return content;
}

// ── AI Player Registry ──
// Maps aiId -> AIPlayer instance. Only the client that created the AI runs its brain.
const aiPlayerRegistry = new Map();

// Counter for unique AI IDs per session
let aiIdCounter = 0;

function generateAIId(team, seatRole) {
  aiIdCounter++;
  return `ai_${team}_${seatRole}_${Date.now()}_${aiIdCounter}`;
}

// AI Names pool
const AI_NAMES = {
  helper: ['Atlas', 'Nova', 'Echo', 'Sage', 'Pixel', 'Cipher', 'Spark', 'Drift'],
  autonomous: ['Cortex', 'Nexus', 'Vanguard', 'Oracle', 'Phantom', 'Titan', 'Blitz', 'Axiom'],
};
let aiNameIndex = { helper: 0, autonomous: 0 };

function getNextAIName(mode) {
  const pool = AI_NAMES[mode] || AI_NAMES.helper;
  const name = pool[aiNameIndex[mode] % pool.length];
  aiNameIndex[mode]++;
  return name;
}

// ── AI Player Class ──
class AIPlayer {
  constructor({ team, seatRole, aiMode, gameDocId }) {
    this.id = generateAIId(team, seatRole);
    this.team = team;             // 'red' | 'blue'
    this.seatRole = seatRole;     // 'spymaster' | 'operative'
    this.aiMode = aiMode;         // 'helper' | 'autonomous'
    this.name = `[AI] ${getNextAIName(aiMode)}`;
    this.gameDocId = gameDocId || window.QUICKPLAY_DOC_ID || 'quickplay';
    this.status = 'pending';      // 'pending' | 'error' | 'warning' | 'ready'
    this.isProcessing = false;
    this.lastActionPhase = null;
    this.lastActionTeam = null;
    this.chatCooldown = false;
    this._destroyed = false;
  }

  // ── Ready-up Verification ──
  async verifyReady() {
    this.status = 'pending';
    this._broadcastStatus();

    try {
      const content = await nebiusChat([
        { role: 'system', content: 'You are a Codenames AI player about to join a game. Respond with exactly the word "Ready" if you are operational.' },
        { role: 'user', content: 'Are you ready to play Codenames?' }
      ], { temperature: 0 });

      if (content.trim() === 'Ready') {
        this.status = 'ready';
      } else {
        this.status = 'warning';
      }
    } catch (err) {
      console.error(`AI ${this.id} ready check failed:`, err);
      this.status = 'error';
    }

    this._broadcastStatus();
    return this.status;
  }

  // ── Join Lobby ──
  async joinLobby() {
    const ref = db.collection('games').doc(this.gameDocId);
    try {
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) throw new Error('Lobby not found');
        const game = snap.data();

        const key = this.team === 'red' ? 'redPlayers' : 'bluePlayers';
        const players = Array.isArray(game[key]) ? [...game[key]] : [];

        // Don't add duplicates
        if (players.some(p => p.odId === this.id)) return;

        players.push({
          odId: this.id,
          name: this.name,
          ready: false,
          role: this.seatRole,
          isAI: true,
          aiMode: this.aiMode,
          aiStatus: this.status,
        });

        tx.update(ref, {
          [key]: players,
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
      });
    } catch (err) {
      console.error(`AI ${this.id} failed to join lobby:`, err);
      throw err;
    }
  }

  // ── Update AI status in Firestore ──
  async _broadcastStatus() {
    if (this._destroyed) return;
    const ref = db.collection('games').doc(this.gameDocId);
    try {
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) return;
        const game = snap.data();
        const key = this.team === 'red' ? 'redPlayers' : 'bluePlayers';
        const players = Array.isArray(game[key]) ? [...game[key]] : [];
        const idx = players.findIndex(p => p.odId === this.id);
        if (idx === -1) return;

        players[idx] = { ...players[idx], aiStatus: this.status };
        tx.update(ref, {
          [key]: players,
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
      });
    } catch (err) {
      console.error(`AI ${this.id} status broadcast failed:`, err);
    }
  }

  // ── Set AI as ready in lobby ──
  async setReady() {
    const ref = db.collection('games').doc(this.gameDocId);
    try {
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) return;
        const game = snap.data();
        if (game.currentPhase && game.currentPhase !== 'waiting') return;

        const key = this.team === 'red' ? 'redPlayers' : 'bluePlayers';
        const players = Array.isArray(game[key]) ? [...game[key]] : [];
        const idx = players.findIndex(p => p.odId === this.id);
        if (idx === -1) return;

        players[idx] = { ...players[idx], ready: true };
        tx.update(ref, {
          [key]: players,
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
      });
    } catch (err) {
      console.error(`AI ${this.id} ready toggle failed:`, err);
    }
  }

  // ── Remove from lobby / game ──
  async remove() {
    this._destroyed = true;
    const ref = db.collection('games').doc(this.gameDocId);
    try {
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) return;
        const game = snap.data();
        const id = this.id;

        const nextRed = (game.redPlayers || []).filter(p => p.odId !== id);
        const nextBlue = (game.bluePlayers || []).filter(p => p.odId !== id);
        const nextSpec = (game.spectators || []).filter(p => p.odId !== id);

        tx.update(ref, {
          redPlayers: nextRed,
          bluePlayers: nextBlue,
          spectators: nextSpec,
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
      });
    } catch (err) {
      console.error(`AI ${this.id} removal failed:`, err);
    }
    aiPlayerRegistry.delete(this.id);
  }

  // ── Game State Observation (called on every game snapshot) ──
  async onGameStateChange(game) {
    if (this._destroyed || this.isProcessing) return;
    if (!game || game.winner || game.currentPhase === 'ended' || game.currentPhase === 'waiting') return;

    const phaseKey = `${game.currentPhase}_${game.currentTeam}_${game.guessesRemaining}`;
    if (this.lastActionPhase === phaseKey) return;

    const isMyTeamTurn = game.currentTeam === this.team;

    // AI Helper mode: react in chat but never take actions
    if (this.aiMode === 'helper') {
      if (isMyTeamTurn && game.currentPhase === 'operatives' && game.currentClue) {
        await this._helperReact(game);
        this.lastActionPhase = phaseKey;
      }
      return;
    }

    // AI Autonomous mode: full player actions
    if (this.aiMode === 'autonomous') {
      if (isMyTeamTurn && game.currentPhase === 'spymaster' && this.seatRole === 'spymaster') {
        this.lastActionPhase = phaseKey;
        await this._autonomousGiveClue(game);
      } else if (isMyTeamTurn && game.currentPhase === 'operatives' && this.seatRole === 'operative') {
        this.lastActionPhase = phaseKey;
        await this._autonomousGuess(game);
      }
    }
  }

  // ── Helper Mode: React in chat ──
  async _helperReact(game) {
    if (this.chatCooldown || this._destroyed) return;
    this.chatCooldown = true;
    setTimeout(() => { this.chatCooldown = false; }, 5000);

    try {
      const boardContext = this._buildBoardContext(game, false);
      const clue = game.currentClue;
      const clueHistory = (game.clueHistory || []).map(c => `${c.team.toUpperCase()}: "${c.word}" for ${c.number}`).join('\n');

      const messages = [
        {
          role: 'system',
          content: `You are a helpful AI teammate in a Codenames game. You are on the ${this.team.toUpperCase()} team as a helper operative.

RULES:
- You can see the board words but NOT their hidden types (you're an operative, not spymaster)
- Suggest which cards might match the clue based on word associations
- Be brief and conversational (1-3 sentences)
- Use reasoning about word connections
- You NEVER select cards yourself - just discuss
- React to the current clue and help your teammates think

BOARD WORDS (unrevealed):
${boardContext}

CLUE HISTORY:
${clueHistory || 'None yet'}

Current clue: "${clue.word}" for ${clue.number}
Guesses remaining: ${game.guessesRemaining}`
        },
        {
          role: 'user',
          content: `The spymaster just gave the clue "${clue.word}" for ${clue.number}. What cards do you think match? Share your thoughts briefly.`
        }
      ];

      const response = await nebiusChat(messages, { temperature: 0.8 });
      await this._sendChatMessage(game, response.trim());
    } catch (err) {
      console.error(`AI Helper ${this.id} chat failed:`, err);
    }
  }

  // ── Autonomous Spymaster: Give Clue ──
  async _autonomousGiveClue(game) {
    if (this._destroyed) return;
    this.isProcessing = true;

    try {
      // First, think aloud in chat
      const boardInfo = this._buildBoardContext(game, true);
      const clueHistory = (game.clueHistory || []).map(c => `${c.team.toUpperCase()}: "${c.word}" for ${c.number}`).join('\n');

      // Step 1: Think aloud in chat
      const thinkMessages = [
        {
          role: 'system',
          content: `You are an autonomous AI Spymaster in Codenames on the ${this.team.toUpperCase()} team.

You can see ALL cards and their types. You need to come up with a clue.

CARD LAYOUT (type | word):
${boardInfo}

Cards left - Red: ${game.redCardsLeft}, Blue: ${game.blueCardsLeft}

CLUE HISTORY:
${clueHistory || 'None yet'}

Think out loud about your strategy. Which of YOUR team's unrevealed cards can you connect? What clue links them?
Be brief (2-3 sentences). Share your thinking process but do NOT reveal card types to teammates.`
        },
        { role: 'user', content: 'Think aloud about what clue to give. Remember, don\'t reveal which cards belong to which team!' }
      ];

      const thinking = await nebiusChat(thinkMessages, { temperature: 0.7 });
      await this._sendChatMessage(game, thinking.trim());

      // Step 2: Generate structured clue
      await this._delay(2000);

      const boardWords = game.cards.map(c => c.word.toUpperCase());
      const clueMessages = [
        {
          role: 'system',
          content: `You are an AI Spymaster in Codenames on the ${this.team.toUpperCase()} team.

CARD LAYOUT (type | word):
${boardInfo}

Cards left - Red: ${game.redCardsLeft}, Blue: ${game.blueCardsLeft}

RULES:
- Your clue must be a SINGLE word (no spaces, no hyphens)
- Your clue CANNOT be any word currently on the board: ${boardWords.join(', ')}
- The number is how many cards your clue relates to
- Try to connect multiple of YOUR team's unrevealed cards
- AVOID clues that could lead to the assassin or opposing team's cards
- Output valid JSON matching the schema`
        },
        { role: 'user', content: 'Give your clue as JSON with "clue" (single word, uppercase) and "number" (integer 1-9).' }
      ];

      const clueContent = await nebiusChat(clueMessages, {
        responseFormat: SPYMASTER_CLUE_SCHEMA,
        temperature: 0.4,
      });

      let parsed;
      try {
        parsed = JSON.parse(clueContent);
      } catch {
        console.error('AI clue parse error:', clueContent);
        this.isProcessing = false;
        return;
      }

      const clueWord = String(parsed.clue || '').trim().toUpperCase();
      const clueNumber = parseInt(parsed.number, 10);

      if (!clueWord || clueWord.includes(' ') || isNaN(clueNumber) || clueNumber < 0 || clueNumber > 9) {
        console.error('AI generated invalid clue:', parsed);
        this.isProcessing = false;
        return;
      }

      if (boardWords.includes(clueWord)) {
        console.error('AI clue is a board word:', clueWord);
        this.isProcessing = false;
        return;
      }

      // Submit the clue to Firestore
      await this._submitClue(game, clueWord, clueNumber);
    } catch (err) {
      console.error(`AI Spymaster ${this.id} clue failed:`, err);
    }

    this.isProcessing = false;
  }

  // ── Autonomous Operative: Guess Cards ──
  async _autonomousGuess(game) {
    if (this._destroyed || !game.currentClue) return;
    this.isProcessing = true;

    try {
      const boardContext = this._buildBoardContext(game, false);
      const clue = game.currentClue;
      const clueHistory = (game.clueHistory || []).map(c =>
        `${c.team.toUpperCase()}: "${c.word}" for ${c.number}${c.results?.length ? ' -> ' + c.results.map(r => `${r.word}(${r.result})`).join(', ') : ''}`
      ).join('\n');

      // Step 1: Reason aloud in chat
      const thinkMessages = [
        {
          role: 'system',
          content: `You are an autonomous AI Operative in Codenames on the ${this.team.toUpperCase()} team.

You can see the board words but NOT their hidden types.

BOARD (unrevealed words):
${boardContext}

CLUE HISTORY:
${clueHistory || 'None yet'}

Current clue: "${clue.word}" for ${clue.number}
Guesses remaining: ${game.guessesRemaining}

Think aloud about which cards might match the clue "${clue.word}". Consider word associations, previous clues, and eliminated cards.
Be direct and conversational (2-3 sentences). You can disagree with teammates if you think differently.`
        },
        { role: 'user', content: `The clue is "${clue.word}" for ${clue.number}. Reason about which card to pick. Be conversational.` }
      ];

      const thinking = await nebiusChat(thinkMessages, { temperature: 0.7 });
      await this._sendChatMessage(game, thinking.trim());

      // Step 2: Pick a card
      await this._delay(3000);

      const unrevealed = game.cards
        .map((c, i) => ({ word: c.word, index: i, revealed: c.revealed }))
        .filter(c => !c.revealed);

      const guessMessages = [
        {
          role: 'system',
          content: `You are an AI Operative in Codenames. Pick a card to guess.

UNREVEALED CARDS: ${unrevealed.map(c => c.word).join(', ')}

Current clue: "${clue.word}" for ${clue.number}
Guesses remaining: ${game.guessesRemaining}

CLUE HISTORY:
${clueHistory || 'None yet'}

Pick the card you're most confident about. The "cardWord" must be EXACTLY one of the unrevealed card words listed above.
Output JSON with "cardWord" (exact match), "confidence" (0.0-1.0), and "reasoning" (brief).`
        },
        { role: 'user', content: `Which card do you want to guess for the clue "${clue.word}"?` }
      ];

      const guessContent = await nebiusChat(guessMessages, {
        responseFormat: OPERATIVE_GUESS_SCHEMA,
        temperature: 0.3,
      });

      let parsed;
      try {
        parsed = JSON.parse(guessContent);
      } catch {
        console.error('AI guess parse error:', guessContent);
        this.isProcessing = false;
        return;
      }

      const guessWord = String(parsed.cardWord || '').trim().toUpperCase();
      const cardIndex = game.cards.findIndex(c => !c.revealed && c.word.toUpperCase() === guessWord);

      if (cardIndex === -1) {
        console.error('AI guessed invalid card:', guessWord);
        await this._sendChatMessage(game, `Hmm, I wanted to pick "${guessWord}" but something went wrong. Someone else pick!`);
        this.isProcessing = false;
        return;
      }

      // Announce the guess
      await this._sendChatMessage(game, `I'm going with "${game.cards[cardIndex].word}" - ${parsed.reasoning}`);
      await this._delay(1500);

      // Submit the guess
      await this._submitGuess(game, cardIndex);
    } catch (err) {
      console.error(`AI Operative ${this.id} guess failed:`, err);
    }

    this.isProcessing = false;
  }

  // ── Build board context string ──
  _buildBoardContext(game, isSpymaster) {
    if (!game.cards) return 'No cards';
    return game.cards.map((c, i) => {
      if (c.revealed) {
        return `[REVEALED - ${c.type.toUpperCase()}] ${c.word}`;
      }
      if (isSpymaster) {
        return `[${c.type.toUpperCase()}] ${c.word}`;
      }
      return `[ ? ] ${c.word}`;
    }).join('\n');
  }

  // ── Send chat message to team operative chat ──
  async _sendChatMessage(game, text) {
    if (this._destroyed || !text) return;
    const gameId = game.id || this.gameDocId;
    try {
      await db.collection('games').doc(gameId)
        .collection(`${this.team}Chat`)
        .add({
          senderId: this.id,
          senderName: this.name,
          text,
          isAI: true,
          aiMode: this.aiMode,
          createdAt: firebase.firestore.FieldValue.serverTimestamp()
        });
    } catch (err) {
      console.error(`AI ${this.id} chat send failed:`, err);
    }
  }

  // ── Submit clue (Spymaster) ──
  async _submitClue(game, word, number) {
    if (this._destroyed) return;
    const gameId = game.id || this.gameDocId;
    const teamName = this.team === 'red' ? (game.redTeamName || 'Red') : (game.blueTeamName || 'Blue');

    const clueEntry = {
      team: this.team,
      word,
      number,
      results: [],
      timestamp: new Date().toISOString()
    };

    try {
      await db.collection('games').doc(gameId).update({
        currentClue: { word, number },
        guessesRemaining: number + 1,
        currentPhase: 'operatives',
        log: firebase.firestore.FieldValue.arrayUnion(`${teamName} AI Spymaster: "${word}" for ${number}`),
        clueHistory: firebase.firestore.FieldValue.arrayUnion(clueEntry),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      });
    } catch (err) {
      console.error(`AI ${this.id} clue submit failed:`, err);
    }
  }

  // ── Submit guess (Operative) ──
  async _submitGuess(game, cardIndex) {
    if (this._destroyed) return;
    const gameId = game.id || this.gameDocId;

    // Re-fetch game state to avoid stale writes
    const snap = await db.collection('games').doc(gameId).get();
    if (!snap.exists) return;
    const freshGame = { id: snap.id, ...snap.data() };

    if (freshGame.currentPhase !== 'operatives' || freshGame.currentTeam !== this.team) return;
    if (freshGame.winner) return;

    const card = freshGame.cards[cardIndex];
    if (!card || card.revealed) return;

    const updatedCards = [...freshGame.cards];
    updatedCards[cardIndex] = { ...card, revealed: true };

    const teamName = this.team === 'red' ? (freshGame.redTeamName || 'Red') : (freshGame.blueTeamName || 'Blue');
    const updates = {
      cards: updatedCards,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    };

    let logEntry = `${teamName} AI guessed "${card.word}" - `;
    let endTurn = false;
    let winner = null;

    if (card.type === 'assassin') {
      winner = this.team === 'red' ? 'blue' : 'red';
      logEntry += 'ASSASSIN! Game over.';
    } else if (card.type === this.team) {
      logEntry += 'Correct!';
      if (this.team === 'red') {
        updates.redCardsLeft = freshGame.redCardsLeft - 1;
        if (updates.redCardsLeft === 0) winner = 'red';
      } else {
        updates.blueCardsLeft = freshGame.blueCardsLeft - 1;
        if (updates.blueCardsLeft === 0) winner = 'blue';
      }
      updates.guessesRemaining = freshGame.guessesRemaining - 1;
      if (updates.guessesRemaining <= 0 && !winner) endTurn = true;
    } else if (card.type === 'neutral') {
      logEntry += 'Neutral. Turn ends.';
      endTurn = true;
    } else {
      logEntry += `Wrong! (${card.type}'s card)`;
      if (card.type === 'red') {
        updates.redCardsLeft = freshGame.redCardsLeft - 1;
        if (updates.redCardsLeft === 0) winner = 'red';
      } else if (card.type === 'blue') {
        updates.blueCardsLeft = freshGame.blueCardsLeft - 1;
        if (updates.blueCardsLeft === 0) winner = 'blue';
      }
      endTurn = true;
    }

    updates.log = firebase.firestore.FieldValue.arrayUnion(logEntry);

    if (winner) {
      updates.winner = winner;
      updates.currentPhase = 'ended';
    } else if (endTurn) {
      updates.currentTeam = this.team === 'red' ? 'blue' : 'red';
      updates.currentPhase = 'spymaster';
      updates.currentClue = null;
      updates.guessesRemaining = 0;
    }

    try {
      await db.collection('games').doc(gameId).update(updates);

      // Append to clue history
      const clueWord = freshGame.currentClue?.word;
      const clueNum = freshGame.currentClue?.number;
      if (clueWord !== undefined && clueNum !== undefined) {
        const guessResult = {
          word: card.word,
          result: card.type === 'assassin' ? 'assassin' : (card.type === this.team ? 'correct' : (card.type === 'neutral' ? 'neutral' : 'wrong')),
          type: card.type,
          by: this.name,
          timestamp: new Date().toISOString()
        };
        try {
          if (typeof addGuessToClueHistory === 'function') {
            await addGuessToClueHistory(gameId, this.team, clueWord, clueNum, guessResult);
          }
        } catch (_) {}
      }
    } catch (err) {
      console.error(`AI ${this.id} guess submit failed:`, err);
    }
  }

  _delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// ── Public API: Add AI Player ──
async function addAIPlayer(team, seatRole, aiMode) {
  const gameDocId = window.QUICKPLAY_DOC_ID || 'quickplay';
  const ai = new AIPlayer({ team, seatRole, aiMode, gameDocId });
  aiPlayerRegistry.set(ai.id, ai);

  // Join the lobby
  await ai.joinLobby();

  // Verify readiness
  const status = await ai.verifyReady();

  // If ready, auto-ready-up
  if (status === 'ready') {
    await ai.setReady();
  }

  return ai;
}

// ── Public API: Remove AI Player ──
async function removeAIPlayer(aiId) {
  const ai = aiPlayerRegistry.get(aiId);
  if (ai) {
    await ai.remove();
  }
}

// ── Public API: Remove all AI players ──
async function removeAllAIPlayers() {
  const promises = [];
  for (const [id, ai] of aiPlayerRegistry) {
    promises.push(ai.remove());
  }
  await Promise.all(promises);
}

// ── Game State Watcher ──
// Called from game.js whenever the game state changes
function notifyAIPlayersOfGameState(game) {
  if (!game) return;
  for (const [id, ai] of aiPlayerRegistry) {
    ai.onGameStateChange(game).catch(err => {
      console.error(`AI ${id} state handler error:`, err);
    });
  }
}

// ── AI Add Modal Logic ──
let _pendingAITeam = null;
let _pendingAISeatRole = null;

function openAIModal(team, seatRole) {
  _pendingAITeam = team;
  _pendingAISeatRole = seatRole;
  const modal = document.getElementById('ai-add-modal');
  if (modal) {
    modal.style.display = 'flex';
    modal.setAttribute('aria-hidden', 'false');
    void modal.offsetWidth;
    modal.classList.add('modal-open');
  }
}

function closeAIModal() {
  const modal = document.getElementById('ai-add-modal');
  if (modal) {
    modal.classList.remove('modal-open');
    setTimeout(() => {
      if (!modal.classList.contains('modal-open')) {
        modal.style.display = 'none';
      }
    }, 200);
    modal.setAttribute('aria-hidden', 'true');
  }
  _pendingAITeam = null;
  _pendingAISeatRole = null;
}

async function confirmAddAI(mode) {
  if (!_pendingAITeam || !_pendingAISeatRole) return;
  const team = _pendingAITeam;
  const seatRole = _pendingAISeatRole;
  closeAIModal();

  try {
    await addAIPlayer(team, seatRole, mode);
  } catch (err) {
    console.error('Failed to add AI player:', err);
    alert('Failed to add AI player: ' + (err.message || err));
  }
}

// ── Initialize AI Modal event listeners ──
document.addEventListener('DOMContentLoaded', () => {
  // Backdrop click closes modal
  document.getElementById('ai-modal-backdrop')?.addEventListener('click', closeAIModal);
});

// ── Expose to global scope ──
window.aiPlayerRegistry = aiPlayerRegistry;
window.addAIPlayer = addAIPlayer;
window.removeAIPlayer = removeAIPlayer;
window.removeAllAIPlayers = removeAllAIPlayers;
window.notifyAIPlayersOfGameState = notifyAIPlayersOfGameState;
window.openAIModal = openAIModal;
window.closeAIModal = closeAIModal;
window.confirmAddAI = confirmAddAI;
