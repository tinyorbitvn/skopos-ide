import { Shell } from "./Shell";
import styles from "./Shell.module.css";

export function App() {
  return (
    <div data-testid="app-root" className={styles.root}>
      <Shell />
    </div>
  );
}
