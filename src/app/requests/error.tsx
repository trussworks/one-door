"use client";

export default function RequestsError({ reset }: { reset: () => void }) {
  return (
    <section className="grid-container padding-y-4 desktop:padding-y-6">
      <h1 className="font-heading-xl margin-top-0">Requests are unavailable</h1>
      <p>
        We couldn&apos;t load the request queue. Try again in a few minutes.
      </p>
      <button className="usa-button" type="button" onClick={reset}>
        Try again
      </button>
    </section>
  );
}
