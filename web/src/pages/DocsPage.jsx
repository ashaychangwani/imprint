import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useParams, Navigate, Link, useLocation } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSlug from 'rehype-slug';
import rehypeHighlight from 'rehype-highlight';
import { docsManifest, docsContent } from '../data/docs-manifest.js';
import './DocsPage.css';

const allSlugs = docsManifest.flatMap(cat => cat.items.map(i => i.slug));

function extractToc(markdown) {
  const headings = [];
  const lines = markdown.split('\n');
  let inCodeBlock = false;
  for (const line of lines) {
    if (line.startsWith('```')) { inCodeBlock = !inCodeBlock; continue; }
    if (inCodeBlock) continue;
    const match = line.match(/^(#{2,3})\s+(.+)$/);
    if (match) {
      const level = match[1].length;
      const text = match[2].replace(/[`*_[\]]/g, '').trim();
      const id = text.toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-').replace(/-+$/, '');
      headings.push({ level, text, id });
    }
  }
  return headings;
}

function findTitle(slug) {
  for (const cat of docsManifest) {
    const item = cat.items.find(i => i.slug === slug);
    if (item) return item.title;
  }
  return slug;
}

const GITHUB_BASE = 'https://github.com/ashaychangwani/imprint/blob/main';

function transformDocLinks(href) {
  if (!href) return href;
  const match = href.match(/^(?:\.\/|\.\.\/docs\/)?([a-z][\w-]*)\.md(#.*)?$/);
  if (match) return `/docs/${match[1]}${match[2] || ''}`;
  if (href.startsWith('../')) {
    return `${GITHUB_BASE}/${href.replace('../', '')}`;
  }
  return href;
}

function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  }, [text]);

  return (
    <button
      className={`code-copy-btn${copied ? ' copied' : ''}`}
      onClick={handleCopy}
      aria-label="Copy code"
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

const markdownComponents = {
  a: ({ href, children, ...props }) => {
    const transformed = transformDocLinks(href);
    if (transformed?.startsWith('/docs/')) {
      return <Link to={transformed} {...props}>{children}</Link>;
    }
    if (transformed?.startsWith('http')) {
      return <a href={transformed} target="_blank" rel="noopener noreferrer" {...props}>{children}</a>;
    }
    return <a href={transformed} {...props}>{children}</a>;
  },
  pre: ({ children, ...props }) => {
    const codeText = extractText(children);
    return (
      <div className="code-block-wrapper">
        <pre {...props}>{children}</pre>
        <CopyButton text={codeText} />
      </div>
    );
  },
  table: ({ children, ...props }) => (
    <div className="table-wrapper">
      <table {...props}>{children}</table>
    </div>
  ),
};

function extractText(node) {
  if (typeof node === 'string') return node;
  if (!node) return '';
  if (Array.isArray(node)) return node.map(extractText).join('');
  if (node.props?.children) return extractText(node.props.children);
  return '';
}

function DocsHeader({ sidebarOpen, onToggleSidebar }) {
  return (
    <header className="docs-header">
      <div className="docs-header-inner">
        <div className="docs-header-left">
          <button
            className="docs-menu-btn"
            onClick={onToggleSidebar}
            aria-label={sidebarOpen ? 'Close menu' : 'Open menu'}
          >
            {sidebarOpen ? '✕' : '☰'}
          </button>
          <Link to="/" className="brand" aria-label="Imprint home">
            <span className="brand-mark" aria-hidden="true">
              <span className="mark-track"></span>
              <span className="mark-dot dot-a"></span>
              <span className="mark-dot dot-b"></span>
            </span>
            <span className="brand-word">Imprint</span>
          </Link>
          <span className="docs-breadcrumb-sep" aria-hidden="true">/</span>
          <span className="docs-label">Docs</span>
        </div>
        <div className="docs-header-right">
          <Link to="/" className="docs-header-link">Home</Link>
          <a className="docs-header-link" href="https://github.com/ashaychangwani/imprint" target="_blank" rel="noopener noreferrer">GitHub ↗</a>
        </div>
      </div>
    </header>
  );
}

function DocsSidebar({ activeSlug, open, onClose }) {
  return (
    <aside className={`docs-sidebar${open ? ' open' : ''}`}>
      <nav aria-label="Documentation navigation">
        {docsManifest.map(category => (
          <div key={category.category} className="sidebar-category">
            <h3 className="sidebar-category-title">{category.category}</h3>
            <ul className="sidebar-list">
              {category.items.map(item => (
                <li key={item.slug}>
                  <Link
                    to={`/docs/${item.slug}`}
                    className={`sidebar-link${activeSlug === item.slug ? ' sidebar-link-active' : ''}`}
                    onClick={onClose}
                  >
                    {item.title}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>
    </aside>
  );
}

function TableOfContents({ headings }) {
  if (headings.length < 3) return null;
  return (
    <nav className="docs-toc" aria-label="Table of contents">
      <h4 className="toc-title">On this page</h4>
      <ul className="toc-list">
        {headings.map((h, i) => (
          <li key={i} className={`toc-item toc-level-${h.level}`}>
            <a href={`#${h.id}`} className="toc-link">{h.text}</a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function DocsFooterNav({ prev, next }) {
  return (
    <nav className="docs-footer-nav" aria-label="Pagination">
      {prev ? (
        <Link to={`/docs/${prev}`} className="footer-nav-link prev">
          <span className="footer-nav-label">← Previous</span>
          <span className="footer-nav-title">{findTitle(prev)}</span>
        </Link>
      ) : <div />}
      {next ? (
        <Link to={`/docs/${next}`} className="footer-nav-link next">
          <span className="footer-nav-label">Next →</span>
          <span className="footer-nav-title">{findTitle(next)}</span>
        </Link>
      ) : <div />}
    </nav>
  );
}

export default function DocsPage() {
  const { slug } = useParams();
  const location = useLocation();
  const activeSlug = slug || 'getting-started';
  const markdown = docsContent[activeSlug];
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const toc = useMemo(() => markdown ? extractToc(markdown) : [], [markdown]);
  const pageTitle = findTitle(activeSlug);

  useEffect(() => {
    document.title = `${pageTitle} — Imprint Docs`;
    return () => { document.title = 'Imprint — deterministic browser skills for AI agents'; };
  }, [pageTitle]);

  useEffect(() => {
    if (location.hash) {
      const el = document.getElementById(location.hash.slice(1));
      if (el) {
        setTimeout(() => el.scrollIntoView({ behavior: 'smooth' }), 50);
      }
    } else {
      window.scrollTo(0, 0);
    }
  }, [activeSlug, location.hash]);

  useEffect(() => {
    setSidebarOpen(false);
  }, [activeSlug]);

  if (!markdown) return <Navigate to="/docs/getting-started" replace />;

  const currentIndex = allSlugs.indexOf(activeSlug);
  const prevSlug = currentIndex > 0 ? allSlugs[currentIndex - 1] : null;
  const nextSlug = currentIndex < allSlugs.length - 1 ? allSlugs[currentIndex + 1] : null;

  return (
    <div className="docs-layout">
      <DocsHeader
        sidebarOpen={sidebarOpen}
        onToggleSidebar={() => setSidebarOpen(o => !o)}
      />
      {sidebarOpen && (
        <div
          className="docs-sidebar-overlay open"
          onClick={() => setSidebarOpen(false)}
        />
      )}
      <DocsSidebar
        activeSlug={activeSlug}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
      />
      <main className="docs-main">
        <div className="docs-content-wrapper">
          <div className="docs-content-col">
            <article className="docs-article">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[rehypeSlug, rehypeHighlight]}
                components={markdownComponents}
              >
                {markdown}
              </ReactMarkdown>
            </article>
            <DocsFooterNav prev={prevSlug} next={nextSlug} />
          </div>
          <TableOfContents headings={toc} />
        </div>
      </main>
    </div>
  );
}
