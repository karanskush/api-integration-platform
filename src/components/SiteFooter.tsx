// Shared by both shells — the footer is the one place marketing and console
// should never drift apart.
export default function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="footer-inner">
        <span>DocentAPI · behavior-verified API integration</span>
        <span className="footer-links">
          <a href="https://github.com/karanskush/api-integration-platform">GitHub</a>
          <a href="mailto:hello@docentapi.dev">Contact</a>
        </span>
      </div>
    </footer>
  );
}
