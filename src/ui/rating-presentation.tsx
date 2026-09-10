"use client";

import { Problem } from "./fields";

const ratingError = "Choose a rating from 1 to 5 to complete this task.";

export function RatingErrorSummary({ invalid }: { invalid: boolean }) {
  return invalid ? (
    <div className="rating-error-summary">
      <Problem>
        <a href="#task-rating-1">{ratingError}</a>
      </Problem>
    </div>
  ) : null;
}

export function TaskRating({
  value,
  onChange,
  invalid,
  onMissing,
}: {
  value: string;
  onChange: (value: string) => void;
  invalid: boolean;
  onMissing: () => void;
}) {
  function requireRating(event: React.InvalidEvent<HTMLInputElement>) {
    event.preventDefault();
    onMissing();
    const group = event.currentTarget.closest("fieldset");
    group?.scrollIntoView({ block: "center" });
    group?.querySelector("input")?.focus({ preventScroll: true });
  }
  return (
    <fieldset
      className="usa-fieldset task-rating"
      role="radiogroup"
      aria-invalid={invalid || undefined}
    >
      <legend className="usa-legend">
        How satisfied are you with performing your task?
      </legend>
      <p className="usa-hint" id="rating-hint">
        1 = completely dissatisfied; 5 = completely satisfied.
      </p>
      {invalid && (
        <p id="rating-error" className="usa-error-message" role="alert">
          {ratingError}
        </p>
      )}
      <div className="rating-options">
        {[1, 2, 3, 4, 5].map((rating) => (
          <label key={rating}>
            <input
              type="radio"
              id={"task-rating-" + rating}
              name="rating"
              value={rating}
              checked={value === String(rating)}
              onChange={(event) => {
                onChange(event.target.value);
              }}
              onInvalid={requireRating}
              aria-describedby={
                invalid ? "rating-hint rating-error" : "rating-hint"
              }
              required
            />
            {rating}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
