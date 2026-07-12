"use client";

import { useEffect, useMemo, useState } from "react";
import {
  BookOpen,
  Brush,
  Database,
  FolderOpen,
  Layers,
  Monitor,
  Palette,
  Rocket,
  Search,
  SlidersHorizontal,
  Sparkles,
  SquareDashed,
  Type,
  X,
  type LucideIcon,
} from "lucide-react";
import styles from "./PreferencesDialog.module.scss";
import { filterTopics, GUIDE, TOPICS, type HelpTopic } from "../lib/help";

/** Which page the window opens on: the guide, or the reference topics. */
export type HelpStart = "start" | "docs";

const TOPIC_ICONS: Record<string, LucideIcon> = {
  tools: Brush,
  selections: SquareDashed,
  layers: Layers,
  adjustments: SlidersHorizontal,
  filters: Sparkles,
  textvector: Type,
  files: FolderOpen,
  colorman: Palette,
  view: Monitor,
  privacy: Database,
};

const GUIDE_ID = "guide";

function TopicPane({ topic }: { topic: HelpTopic }) {
  return (
    <>
      {topic.intro && <p className={styles.paneIntro}>{topic.intro}</p>}
      {topic.sections.map((s) => (
        <section key={s.title} className={styles.section}>
          <span className={styles.groupLabel}>{s.title}</span>
          <div className={styles.docList}>
            {s.entries.map((e) => (
              <div key={e.title} className={styles.docEntry}>
                <span className={styles.docText}>
                  <strong>{e.title}</strong>
                  <em>{e.body}</em>
                </span>
                {e.keys && <span className={styles.kbdChip}>{e.keys}</span>}
              </div>
            ))}
          </div>
        </section>
      ))}
    </>
  );
}

/** Getting started + searchable documentation, one window (Help menu). */
export default function HelpDialog({ start, onClose }: { start: HelpStart; onClose: () => void }) {
  const [page, setPage] = useState<string>(start === "start" ? GUIDE_ID : TOPICS[0].id);
  const [query, setQuery] = useState("");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const q = query.trim();
  const results = useMemo(() => (q ? filterTopics(TOPICS, q) : null), [q]);
  const current = TOPICS.find((t) => t.id === page) ?? TOPICS[0];

  return (
    <div className={styles.overlay} onMouseDown={onClose}>
      <div
        className={`${styles.dialog} ${styles.prefsDialog}`}
        role="dialog"
        aria-modal="true"
        aria-label="Help"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className={styles.head}>
          <h2>Help</h2>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </header>

        <div className={styles.prefsLayout}>
          <nav className={styles.prefsNav} aria-label="Help topics">
            <div className={styles.searchBox} style={{ marginBottom: 6 }}>
              <Search size={14} />
              <input
                autoFocus
                value={query}
                placeholder="Search the docs…"
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <button
              type="button"
              className={styles.prefsNavItem}
              data-active={!results && page === GUIDE_ID}
              onClick={() => {
                setQuery("");
                setPage(GUIDE_ID);
              }}
            >
              <Rocket size={15} />
              Getting started
            </button>
            {TOPICS.map((t) => {
              const Icon = TOPIC_ICONS[t.id] ?? BookOpen;
              return (
                <button
                  key={t.id}
                  type="button"
                  className={styles.prefsNavItem}
                  data-active={!results && page === t.id}
                  onClick={() => {
                    setQuery("");
                    setPage(t.id);
                  }}
                >
                  <Icon size={15} />
                  {t.label}
                </button>
              );
            })}
          </nav>

          <div className={styles.prefsPane}>
            {results ? (
              results.length ? (
                results.map((t) => (
                  <section key={t.id} className={styles.section}>
                    <span className={styles.groupLabel}>{t.label}</span>
                    <div className={styles.docList}>
                      {t.sections.flatMap((s) =>
                        s.entries.map((e) => (
                          <div key={`${s.title}|${e.title}`} className={styles.docEntry}>
                            <span className={styles.docText}>
                              <strong>{e.title}</strong>
                              <em>{e.body}</em>
                            </span>
                            {e.keys && <span className={styles.kbdChip}>{e.keys}</span>}
                          </div>
                        )),
                      )}
                    </div>
                  </section>
                ))
              ) : (
                <div className={styles.noResults}>No help entries match “{query}”.</div>
              )
            ) : page === GUIDE_ID ? (
              <>
                <p className={styles.paneIntro}>
                  Seven steps from a blank canvas to an exported picture. Everything here runs
                  entirely in your browser — nothing is uploaded.
                </p>
                <div className={styles.docList}>
                  {GUIDE.map((e, i) => (
                    <div key={e.title} className={styles.docEntry}>
                      <span className={styles.guideNum}>{i + 1}</span>
                      <span className={styles.docText}>
                        <strong>{e.title}</strong>
                        <em>{e.body}</em>
                      </span>
                      {e.keys && <span className={styles.kbdChip}>{e.keys}</span>}
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <TopicPane topic={current} />
            )}
          </div>
        </div>

        <footer className={styles.foot}>
          <button type="button" className={`${styles.btn} ${styles.primary}`} onClick={onClose}>
            Done
          </button>
        </footer>
      </div>
    </div>
  );
}
