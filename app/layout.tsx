import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { getServerTheme } from "./lib/theme.server";
import "./globals.scss";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Aperture — Photo Editor",
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

  return (
    <html lang="en" data-theme={theme} suppressHydrationWarning>
      <body className={`${geistSans.variable} ${geistMono.variable}`}>
        {children}
      </body>
    </html>
  );
}
