import type { Metadata, Viewport } from "next";
import { MOBILE_QUERY, TABLET_QUERY, TOUCH_QUERY } from "./lib/breakpoint";
import { INSTALL_EVENT, INSTALL_SLOT } from "./lib/space";
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
  /* Ask the browser to RESIZE the page when the keyboard opens rather than draw
     it over the top. Without it the layout viewport does not move, so anything
     anchored to the bottom — the MobileBar, a dialog's footer — sits behind the
     keyboard: measured at 390×844 with a 300px keyboard, the bar was **300px
     behind it**, i.e. entirely hidden.
     Not a substitute for `--kb-inset`, which stays: `resizes-content` is
     honoured by Chrome on Android and ignored by Safari on iOS, so the CSS
     token driven from `visualViewport` is what makes the two behave alike. */
  interactiveWidget: "resizes-content",
};

export const metadata: Metadata = {
  title: "Graphiq Studio — Photo Editor",
  description: "A modern, clean photo editing studio built with Next.js.",

  /* ---- iOS home screen ----
     Safari ignores the manifest's `display` entirely, so an installed copy on
     an iPhone is a browser tab with a URL bar unless these say otherwise. They
     are the iOS half of the same job `app/manifest.ts` does everywhere else.

     `black-translucent` is doing more than picking a colour. The three styles
     differ in LAYOUT, not appearance: `default` and `black` leave the page
     below the status bar, while `black-translucent` puts the page UNDER it —
     which is the only one of the three that makes `safe-area-inset-top`
     non-zero. That is what the shell's `--safe-t` has been reading since M0,
     and it is why this tag could not land before the top inset did: without
     the inset, a translucent status bar means the top bar slides under the
     clock. With it, the bar grows by exactly the notch (verify-safe-area
     measures the difference, 48 → 95px) and nothing on it is covered.

     `title` is the home-screen label — the document title is far too long for
     one, and iOS truncates rather than wraps. */
  appleWebApp: {
    capable: true,
    title: "Graphiq",
    statusBarStyle: "black-translucent",
  },

  icons: {
    /* iOS applies its own rounded-rect mask with no safe-zone allowance and
       renders transparency as BLACK, so this is neither the `any` icon (which
       would show a black square behind the glyph on some backgrounds) nor the
       maskable one (which would float small inside Apple's own inset). It is
       the full glyph on the opaque ground — see tools/build-pwa-icons.js. */
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
    /* Declaring ANY icon here suppresses Next's file-convention link for
       `app/icon.png`, so before this the document named only the Apple icon and
       the tab fell back to a bare `/favicon.ico` probe. Naming it explicitly
       makes the tab icon a decision rather than a guess — and unlike the Apple
       icon above, both of these are TRANSPARENT, because the tab strip paints
       its own background and it is not always dark. */
    icon: [
      { url: "/favicon.ico", sizes: "16x16 32x32 48x48", type: "image/x-icon" },
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
    ],
  },

  // The app ships its own dark/light theme, so tell the Dark Reader extension
  // to leave the page alone — it otherwise rewrites SVG/inline styles before
  // hydration and triggers hydration-mismatch console errors.
  other: {
    "darkreader-lock": "true",
    /* Next renders `appleWebApp.capable` as the STANDARDISED
       `mobile-web-app-capable`, which is the name Chrome asks for and the one
       it deprecated the Apple spelling in favour of. iOS has only ever been
       documented as honouring `apple-mobile-web-app-capable`, and whether
       Safari now also reads the unprefixed name is not something to find out
       from a device nobody here has. Both are emitted: one line, no
       uncertainty, and the standard name stays the one Chrome sees. */
    "apple-mobile-web-app-capable": "yes",
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
              `(function(){try{var d=document.documentElement;` +
              `var m=matchMedia(${JSON.stringify(MOBILE_QUERY)}).matches;` +
              `if(m)d.dataset.mobile="true";` +
              /* Three attributes, two questions. `data-touch` is the DEVICE and
                 sizes the controls; `data-mobile` / `data-tablet` are the
                 SCREEN and lay them out. Keeping them apart is the whole tier:
                 the 44px floor used to live inside the phone's block, so a
                 tablet — a finger with no hover, exactly like a phone — got
                 mouse-sized controls, 23 kinds of them under 44px. */
              `if(matchMedia(${JSON.stringify(TOUCH_QUERY)}).matches)d.dataset.touch="true";` +
              `if(matchMedia(${JSON.stringify(TABLET_QUERY)}).matches)d.dataset.tablet="true";` +
              /* Rulers default off on any TOUCH device, and that has to be settled here
                 rather than in an effect. Flipping it after mount resized the
                 stage AFTER the one cold-load fit had already run against the
                 taller box, leaving the artwork 22px — one ruler — off centre.
                 A stored choice is read from the same key the editor uses, so
                 the pre-paint answer and the React answer agree. The editor
                 drops this attribute once its own state owns the decision. */
              `if(matchMedia(${JSON.stringify(TOUCH_QUERY)}).matches){var r=null;` +
              `try{r=JSON.parse(localStorage.getItem("pe-view")||"{}").rulers}catch(e2){}` +
              `if(typeof r!=="boolean")d.dataset.rulersDefault="off"}` +
              `}catch(e){}})()`,
          }}
        />
        {/* The install prompt is caught HERE, not in a React effect, because it
            does not wait and it does not replay. `beforeinstallprompt` fires as
            soon as the browser has finished judging the manifest — 308ms on a
            cold load against 303ms for the editor's first paint — and an effect
            attached after hydration lost that race on five cold loads out of
            five. The symptom was the worst kind: a browser willing to install
            the app, and a "More space" panel that never offered it, with
            nothing anywhere saying why.

            `preventDefault()` is what suppresses Chrome's own mini-infobar, and
            it has to happen in the same tick as the event. The editor reads
            what landed here and re-reads on INSTALL_EVENT; spending the prompt
            clears the slot. Separate from the block above on purpose: if
            matchMedia throws, the capture must still be installed. */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              `(function(){try{var w=window;w.${INSTALL_SLOT}=null;` +
              `var f=function(){w.dispatchEvent(new Event(${JSON.stringify(INSTALL_EVENT)}))};` +
              `w.addEventListener("beforeinstallprompt",function(e){` +
              `e.preventDefault();w.${INSTALL_SLOT}=e;f()});` +
              /* Installed: the prompt will not fire again and there is nothing
                 left to offer, so drop it rather than leaving a button that
                 installs what the user is already running. */
              `w.addEventListener("appinstalled",function(){w.${INSTALL_SLOT}=null;f()});` +
              `}catch(e){}})()`,
          }}
        />
      </head>
      {/* atlassianSans.className applies the font directly (immune to var() chains). */}
      <body className={atlassianSans.className}>{children}</body>
    </html>
  );
}
