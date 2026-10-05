"use client";

import { useEffect } from "react";

export default function ProcurementAccess() {
  useEffect(() => {
    window.location.replace("/procurement" + window.location.hash);
  }, []);

  return (
    <>
      <p role="status">Opening the procurement prototype…</p>
      <p>
        <a href="/procurement">Open the procurement prototype</a>
      </p>
    </>
  );
}
