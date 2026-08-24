import type { Metadata, Viewport } from "next";
import { MOBILE_QUERY } from "./lib/breakpoint";
import localFont from "next/font/local";
import { getServerAccent, getServerTheme, getServerUiScale } from "./lib/theme.server";
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

// A photo editor owns the pinch gesture: the canvas zooms on pinch, so the
// PAGE must never zoom. Disable browser page-zoom (the app has its own canvas
// zoom + a UI-scale preference). `viewport-fit: cover` lets the mobile chrome
// use the safe-area insets it references.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
};

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
  const uiScale = await getServerUiScale();

  return (
    <html
      lang="en"
      data-theme={theme}
      data-accent={accent}
      data-uiscale={uiScale}
      data-motion="on"
      className={`${atlassianSans.variable} ${atlassianMono.variable}`}
      suppressHydrationWarning
    >
      <head>
        {/* Which shell to use is a question only the browser can answer — the
            viewport is not sent with the request, so unlike the theme (a
            cookie, resolved above) it cannot be decided server-side. Left to
            React it resolves in an effect, one frame late, and the phone paints
            the DESKTOP layout first: the toolbar and dock in flow, the canvas
            measured against what is left, and then a reflow the moment the
            attribute lands. CanvasArea carried a workaround for exactly that —
            re-fitting an untouched view when the canvas widened underneath it.

            Running here, before the first paint, there is no first layout to
            correct. The query string is the one in lib/breakpoint, inlined
            rather than copied. Failure is silent on purpose: if matchMedia
            throws, the desktop shell is the safe answer and the effect still
            puts it right a frame later. */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              `(function(){try{var m=matchMedia(${JSON.stringify(MOBILE_QUERY)}).matches;` +
              `if(m)document.documentElement.dataset.mobile="true";` +
              /* Rulers default off on a phone, and that has to be settled here
                 rather than in an effect. Flipping it after mount resized the
                 stage AFTER the one cold-load fit had already run against the
                 taller box, leaving the artwork 22px — one ruler — off centre.
                 A stored choice is read from the same key the editor uses, so
                 the pre-paint answer and the React answer agree. The editor
                 drops this attribute once its own state owns the decision. */
              `if(m){var r=null;try{r=JSON.parse(localStorage.getItem("pe-view")||"{}").rulers}catch(e2){}` +
              `if(typeof r!=="boolean")document.documentElement.dataset.rulersDefault="off"}` +
              `}catch(e){}})()`,
          }}
        />
      </head>
      {/* atlassianSans.className applies the font directly (immune to var() chains). */}
      <body className={atlassianSans.className}>{children}</body>
    </html>
  );
}
