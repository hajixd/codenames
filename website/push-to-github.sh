#!/bin/bash

# Simple script to push code to GitHub
# Usage: After creating a repo on GitHub, run this script with your repo URL
# Example: ./push-to-github.sh https://github.com/yourusername/codenames-tournament.git

if [ -z "$1" ]; then
    echo "Usage: ./push-to-github.sh <github-repo-url>"
    echo "Example: ./push-to-github.sh https://github.com/yourusername/codenames-tournament.git"
    exit 1
fi

echo "Initializing git repository..."
git init

echo "Adding all files..."
git add .

echo "Creating initial commit..."
git commit -m "Initial commit: Codenames Tournament website"

echo "Setting main branch..."
git branch -M main

echo "Adding remote repository..."
git remote add origin $1

echo "Pushing to GitHub..."
git push -u origin main

echo "Done! Your code is now on GitHub."
