import React from "react";
import { Box, Text, render } from "ink";

function App() {
  return React.createElement(
    Box,
    { flexDirection: "column", padding: 1 },
    React.createElement(Text, { bold: true, color: "green" }, "Specra"),
    React.createElement(
      Text,
      null,
      "Long-running coding CLI agent scaffold is ready."
    )
  );
}

render(React.createElement(App));
