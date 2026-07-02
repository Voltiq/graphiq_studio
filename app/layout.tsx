import type { Metadata } from "next";
import localFont from "next/font/local";
import { getServerAccent, getServerTheme } from "./lib/theme.server";
import "./globals.scss";

// Self-hosted Geist (variable TTFs in app/fonts) — avoids the Google Fonts
// fetch that was failing and falling back to a system font.
const geistSans = localFont({
  variable: "--font-geist-sans",
  display: "swap",
  src: [
    {
      path: "./fonts/Geist-VariableFont_wght.ttf",
      weight: "100 900",
      style: "normal",
    },
    {
      path: "./fonts/Geist-Italic-VariableFont_wght.ttf",
      weight: "100 900",
      style: "italic",
    },
  ],
});

const geistMono = localFont({
  variable: "--font-geist-mono",
  display: "swap",
  src: [
    {
      path: "./fonts/GeistMono-VariableFont_wght.ttf",
      weight: "100 900",
      style: "normal",
    },
    {
      path: "./fonts/GeistMono-Italic-VariableFont_wght.ttf",
      weight: "100 900",
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
      className={`${geistSans.variable} ${geistMono.variable}`}
      suppressHydrationWarning
    >
      {/* geistSans.className applies the font directly (immune to var() chains). */}
      <body className={geistSans.className}>{children}</body>
    </html>
  );
}
