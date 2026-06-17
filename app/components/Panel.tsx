"use client";

import { useState, type ReactNode } from "react";
import { ChevronDown, type LucideIcon } from "lucide-react";
import styles from "./RightDock.module.scss";

export default function Panel({
  title,
  icon: Icon,
  defaultOpen = true,
  actions,
  children,
}: {
  title: string;
  icon: LucideIcon;
  defaultOpen?: boolean;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <section className={styles.panel} data-open={open}>
      <header className={styles.panelHead}>
        <button
          type="button"
          className={styles.panelTitle}
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          <ChevronDown className={styles.chevron} size={14} />
          <Icon size={14} />
          <span>{title}</span>
        </button>
        {actions && <div className={styles.panelActions}>{actions}</div>}
      </header>
      {open && <div className={styles.panelBody}>{children}</div>}
    </section>
  );
}
