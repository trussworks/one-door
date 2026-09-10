import Link from "next/link";
import styles from "./page.module.css";

export default function Home() {
  return (
    <div className={styles.landing}>
      <section className={styles.landingIntro}>
        <p className={styles.landingEyebrow}>
          Colorado Office of Information Technology · Pilot
        </p>
        <h1>
          Find the right help.
          <br />
          Keep your request moving.
        </h1>
        <p>
          Software and infrastructure support starts with what you need to
          accomplish. One Door connects the request, the people reviewing it,
          and the work that follows.
        </p>
      </section>
      <section aria-labelledby="choose-workflow">
        <h2 id="choose-workflow">How will you use One Door?</h2>
        <div className={styles.workflowChoices}>
          <article>
            <p className={styles.landingEyebrow}>Requester</p>
            <h3>Get help for your team</h3>
            <p>
              Describe a need, find possible solutions, and follow your request.
              You do not need to know the service name.
            </p>
            <Link href="/my" className="usa-button">
              Open my requests
            </Link>
          </article>
          <article>
            <p className={styles.landingEyebrow}>Reviewer</p>
            <h3>Review and move work forward</h3>
            <p>
              Find your assignments, review the evidence, and help a requester
              reach the next step.
            </p>
            <Link href="/review" className="usa-button">
              Open my review queue
            </Link>
          </article>
          <article>
            <p className={styles.landingEyebrow}>Administrator</p>
            <h3>Coordinate the whole service</h3>
            <p>
              See everyone's requests, assign work, maintain the inventory, and
              track outcomes.
            </p>
            <Link href="/dashboard" className="usa-button">
              Open administrator dashboard
            </Link>
          </article>
        </div>
      </section>
      <p className={styles.landingNote}>
        You can switch views at any time. This pilot uses fictional inventory,
        policies, and delivery systems. Use fictional information when trying a
        workflow.
      </p>
    </div>
  );
}
