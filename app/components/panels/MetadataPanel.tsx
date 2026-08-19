"use client";

import { useState, type ReactNode } from "react";
import type { WorkingSpace } from "../../lib/colorspace";
import { ExternalLink } from "lucide-react";
import styles from "../RightDock.module.scss";
import { formatBytes, type ImageMetadata } from "../../lib/metadata";

/** Editable metadata row: commits on blur / Enter, Escape reverts. The draft
 *  re-syncs whenever the underlying value changes (document switch, undo). */
function EditRow({
  label,
  value,
  placeholder,
  onCommit,
}: {
  label: string;
  value: string | undefined;
  placeholder: string;
  onCommit: (v: string) => void;
}) {
  const [draft, setDraft] = useState(value ?? "");
  // Re-sync the draft when the incoming value changes — adjusted DURING render
  // rather than in an effect, which is React's documented pattern for it: the
  // effect version paints the stale draft first and only then corrects it.
  const [seen, setSeen] = useState(value);
  if (seen !== value) {
    setSeen(value);
    setDraft(value ?? "");
  }
  const commit = () => {
    const v = draft.trim();
    if (v !== (value ?? "")) onCommit(v);
  };
  return (
    <div className={styles.metaRow}>
      <span className={styles.metaKey}>{label}</span>
      <input
        className={styles.metaInput}
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            commit();
            (e.target as HTMLInputElement).blur();
          } else if (e.key === "Escape") {
            setDraft(value ?? "");
            (e.target as HTMLInputElement).blur();
          }
          e.stopPropagation(); // keep single-letter tool shortcuts out
        }}
        aria-label={label}
      />
    </div>
  );
}

/** Reduce w:h to a small integer ratio for display (e.g. 3:2). */
function aspectRatio(w: number, h: number): string {
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
  const g = gcd(w, h) || 1;
  const rw = w / g;
  const rh = h / g;
  // Avoid silly ratios like 1920:1271 — fall back to a rounded decimal.
  return rw <= 32 && rh <= 32 ? `${rw}:${rh}` : `${(w / h).toFixed(2)}:1`;
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  if (value === undefined || value === null || value === "") return null;
  return (
    <div className={styles.metaRow}>
      <span className={styles.metaKey}>{label}</span>
      <span className={styles.metaVal}>{value}</span>
    </div>
  );
}

/** A section is rendered only when `show` is true (it has at least one value). */
function Section({
  title,
  show = true,
  children,
}: {
  title: string;
  show?: boolean;
  children: ReactNode;
}) {
  if (!show) return null;
  return (
    <div className={styles.metaSection}>
      <span className={styles.metaSectionTitle}>{title}</span>
      {children}
    </div>
  );
}

export default function MetadataPanel({
  name,
  width,
  height,
  dpi = 300,
  colorSpace,
  meta,
  onEdit,
}: {
  name: string;
  width: number;
  height: number;
  dpi?: number;
  colorSpace: WorkingSpace;
  meta: ImageMetadata | null;
  /** Writes description/artist/copyright edits into the document's metadata. */
  onEdit: (patch: Partial<ImageMetadata>) => void;
}) {
  const megapixels = ((width * height) / 1e6).toFixed(width * height >= 1e7 ? 0 : 1);
  const camera = [meta?.make, meta?.model].filter(Boolean).join(" ") || undefined;
  // Some cameras repeat the make inside the model — collapse the duplication.
  const cameraName =
    meta?.make && meta?.model?.startsWith(meta.make) ? meta.model : camera;
  const profile =
    colorSpace === "display-p3"
      ? "Display P3"
      : colorSpace === "adobe-rgb"
        ? "Adobe RGB (1998) — emulated"
        : "sRGB IEC61966-2.1";

  const hasCamera = !!(cameraName || meta?.lensModel || meta?.software);
  const hasCapture = !!(
    meta &&
    (meta.dateTaken || meta.focalLength || meta.focalLength35 || meta.fNumber || meta.exposure || meta.iso)
  );
  return (
    <div className={styles.metadata}>
      <Section title="Document">
        <Row label="Name" value={name} />
        <Row label="Dimensions" value={`${width} × ${height} px`} />
        <Row label="Resolution" value={`${dpi} ppi (${(width / dpi).toFixed(2)} × ${(height / dpi).toFixed(2)} in)`} />
        <Row label="Megapixels" value={`${megapixels} MP`} />
        <Row label="Aspect ratio" value={aspectRatio(width, height)} />
        <Row label="Color mode" value="RGB · 8-bit" />
        <Row label="Profile" value={profile} />
        {meta?.dpi ? <Row label="Resolution" value={`${meta.dpi} DPI`} /> : null}
      </Section>

      {meta ? (
        <Section title="File">
          <Row label="File name" value={meta.fileName} />
          <Row label="Size" value={formatBytes(meta.fileSize)} />
          <Row label="Type" value={meta.fileType || "—"} />
          <Row
            label="Modified"
            value={new Date(meta.lastModified).toLocaleString(undefined, {
              dateStyle: "medium",
              timeStyle: "short",
            })}
          />
        </Section>
      ) : null}

      <Section title="Camera" show={hasCamera}>
        <Row label="Camera" value={cameraName} />
        <Row label="Lens" value={meta?.lensModel} />
        <Row label="Software" value={meta?.software} />
      </Section>

      <Section title="Capture" show={hasCapture}>
        <Row label="Date taken" value={meta?.dateTaken} />
        <Row label="Focal length" value={meta?.focalLength} />
        <Row label="35mm equiv." value={meta?.focalLength35} />
        <Row label="Aperture" value={meta?.fNumber} />
        <Row label="Shutter" value={meta?.exposure} />
        <Row label="ISO" value={meta?.iso} />
      </Section>

      <Section title="Authoring">
        <EditRow
          label="Description"
          value={meta?.description}
          placeholder="Add a description…"
          onCommit={(v) => onEdit({ description: v })}
        />
        <EditRow
          label="Artist"
          value={meta?.artist}
          placeholder="Add an author…"
          onCommit={(v) => onEdit({ artist: v })}
        />
        <EditRow
          label="Copyright"
          value={meta?.copyright}
          placeholder="© …"
          onCommit={(v) => onEdit({ copyright: v })}
        />
        <p className={styles.metaHint} style={{ margin: "4px 0 0" }}>
          Embedded as EXIF/XMP when exporting JPEG, PNG or WebP.
        </p>
      </Section>

      {meta?.gps ? (
        <Section title="Location">
          <Row
            label="Coordinates"
            value={`${meta.gps.lat.toFixed(5)}, ${meta.gps.lon.toFixed(5)}`}
          />
          <div className={styles.metaRow}>
            <span className={styles.metaKey} />
            <a
              className={styles.metaLink}
              href={`https://www.openstreetmap.org/?mlat=${meta.gps.lat}&mlon=${meta.gps.lon}#map=15/${meta.gps.lat}/${meta.gps.lon}`}
              target="_blank"
              rel="noreferrer noopener"
            >
              View on map <ExternalLink size={11} />
            </a>
          </div>
        </Section>
      ) : null}

      {!meta ? (
        <p className={styles.metaHint}>Import a photo to see its camera and EXIF details.</p>
      ) : null}
    </div>
  );
}
