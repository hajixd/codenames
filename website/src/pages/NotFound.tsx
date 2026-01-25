import { Link } from 'react-router-dom';
import './NotFound.css';

const NotFound = () => {
  return (
    <div className="not-found">
      <section className="not-found-hero">
        <div className="container">
          <div className="not-found-content">
            <h1 className="not-found-title">404</h1>
            <p className="not-found-subtitle">Page not found</p>
            <p className="not-found-text">
              The page you&apos;re looking for doesn&apos;t exist or has been moved.
            </p>
            <Link to="/" className="btn btn-primary">
              Back to Home
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
};

export default NotFound;
