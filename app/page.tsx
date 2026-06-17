import Editor from "./components/Editor";
import { getServerTheme } from "./lib/theme.server";

export default async function Home() {
  const theme = await getServerTheme();
  return <Editor initialTheme={theme} />;
}
