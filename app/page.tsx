import Editor from "./components/Editor";
import ErrorBoundary from "./components/ErrorBoundary";
import { getServerTheme } from "./lib/theme.server";

export default async function Home() {
  const theme = await getServerTheme();
  // The boundary wraps the editor rather than living inside it: it has to
  // survive the editor's own teardown to be any use.
  return (
    <ErrorBoundary>
      <Editor initialTheme={theme} />
    </ErrorBoundary>
  );
}
