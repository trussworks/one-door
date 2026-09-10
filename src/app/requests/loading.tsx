import styles from "./loading.module.css";

export default function LoadingRequests() {
  return (
    <section className="grid-container padding-y-4 desktop:padding-y-6">
      <h1 className="font-heading-xl margin-top-0">Request queue</h1>
      <p role="status">Loading requests…</p>
      <div className={styles.table} aria-hidden="true">
        {Array.from({ length: 8 }, (_, index) => (
          <div className={styles.row} key={index} />
        ))}
      </div>
    </section>
  );
}
