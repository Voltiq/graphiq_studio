import type { Metadata } from "next";
import localFont from "next/font/local";
import { getServerAccent, getServerTheme } from "./lib/theme.server";
import "./globals.scss";

// Self-hosted Atlassian Sans / Atlassian Mono (variable TTFs in app/fonts) —
// the product typefaces per DESIGN.md. No third-party fonts.
const atlassianSans = localFont({
  variable: "--font-atlassian-sans",
  display: "swap",
  src: [
    {
      path: "./fonts/AtlassianSans.v3.ttf",
      weight: "100 1000",
      style: "normal",
    },
    {
      path: "./fonts/AtlassianSansItalic.v3.ttf",
      weight: "100 1000",
      style: "italic",
    },
  ],
});

const atlassianMono = localFont({
  variable: "--font-atlassian-mono",
  display: "swap",
  src: [
    {
      path: "./fonts/AtlassianMono.v2.ttf",
      weight: "100 1000",
      style: "normal",
    },
    {
      path: "./fonts/AtlassianMonoItalic.v2.ttf",
      weight: "100 1000",
      style: "italic",
    },
  ],
});

export const metadata: Metadata = {
  title: "Graphiq Studio — Photo Editor",
  description: "A modern, clean photo editing studio built with Next.js.",
  // The app ships its own dark/light theme, so tell the Dark Reader extension
  // to leave the page alone — it otherwise rewrites SVG/inline styles before
  // hydration and triggers hydration-mismatch console errors.
  other: {
    "darkreader-lock": "true",
  },
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const theme = await getServerTheme();
  const accent = await getServerAccent();

  return (
    <html
      lang="en"
      data-theme={theme}
      data-accent={accent}
      data-motion="on"
      className={`${atlassianSans.variable} ${atlassianMono.variable}`}
      suppressHydrationWarning
    >
      {/* atlassianSans.className applies the font directly (immune to var() chains). */}
      <body className={atlassianSans.className}>{children}</body>
    </html>
  );
}
