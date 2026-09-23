import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

const root = document.getElementById("root");
if (root === null) throw new Error("Newsjack investor root is missing.");

// The first mount performs a real provider scan. Avoid development-only effect
// replay duplicating external API calls and audit runs.
createRoot(root).render(<App />);
