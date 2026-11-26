import type { SVGProps } from "react";

export function T3Wordmark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...props} viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M23 7 20 4h-7L6 8l-3 5v6l3 5 7 4h7l3-3-4-4-2 2h-3l-4-2-2-3v-4l2-3 4-2h3l2 2zM21 14h8v4h-8z"
        fill="currentColor"
      />
    </svg>
  );
}
