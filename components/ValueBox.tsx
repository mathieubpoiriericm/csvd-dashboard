interface ValueBoxProps {
  label: string;
  value: number;
}

/** Headline statistic tile used on the About page. */
export function ValueBox({ label, value }: ValueBoxProps) {
  return (
    <div class="value-box">
      <div class="value-box-value">
        {value.toLocaleString("en-US")}
      </div>
      <div class="value-box-label">{label}</div>
    </div>
  );
}
