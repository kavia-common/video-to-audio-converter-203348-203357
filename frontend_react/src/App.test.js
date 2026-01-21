import { render, screen } from "@testing-library/react";
import App from "./App";

test("renders main heading", () => {
  render(<App />);
  const heading = screen.getByRole("heading", { name: /convert mp4 to mp3/i });
  expect(heading).toBeInTheDocument();
});
