import PhotoEditor from "./editor/components/PhotoEditor";
import styles from "./page.module.scss";

const Home = () => {
  return (
    <main className={styles.page}>
      <PhotoEditor />
    </main>
  );
};

export default Home;
