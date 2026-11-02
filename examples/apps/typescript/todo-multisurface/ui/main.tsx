import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { bootTodoUi } from "./client";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("todos ui missing #root");

void bootTodoUi().then((runtime) => {
  createRoot(root).render(
    <StrictMode>
      <App runtime={runtime} />
    </StrictMode>,
  );
});
