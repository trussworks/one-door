"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import styles from "./table-scroll.module.css";

export function tableOverflow(left: number, width: number, total: number) {
  return { left: left > 1, right: left + width < total - 1 };
}

function hiddenColumns({ left, right }: { left: boolean; right: boolean }) {
  if (left && right) return "on both sides";
  return left ? "to the left" : "to the right";
}

export function TableScroll({
  children,
  label,
  className = "",
  fixedHeight = false,
}: {
  children: ReactNode;
  label: string;
  className?: string;
  fixedHeight?: boolean;
}) {
  const region = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState({ left: false, right: false });
  useEffect(() => {
    const element = region.current;
    if (!element) return;
    const measure = () =>
      setOverflow(
        tableOverflow(
          element.scrollLeft,
          element.clientWidth,
          element.scrollWidth,
        ),
      );
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    const table = element.querySelector("table");
    if (table) observer.observe(table);
    element.addEventListener("scroll", measure);
    measure();
    return () => {
      observer.disconnect();
      element.removeEventListener("scroll", measure);
    };
  }, []);
  return (
    <div className={`table-region ${styles.region}`}>
      {(overflow.left || overflow.right) && (
        <span className={styles.overflowHint}>
          {overflow.left && <span aria-hidden="true">← </span>}
          More columns {hiddenColumns(overflow)}
          {overflow.right && <span aria-hidden="true"> →</span>}
        </span>
      )}
      <div
        ref={region}
        className={`${styles.tableScroll} ${className} ${fixedHeight ? styles.fixedHeight : ""}`}
        tabIndex={0}
        role="region"
        aria-label={label}
      >
        {children}
      </div>
    </div>
  );
}
