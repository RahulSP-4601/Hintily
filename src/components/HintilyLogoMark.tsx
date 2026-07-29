import React from 'react';

/**
 * Hintily logomark — an "H" letterform inscribed in the same circular system
 * as the inherited N mark. The original NativelyLogoMark remains untouched.
 */
export const HintilyLogoMark: React.FC<{
  size?: number;
  className?: string;
}> = ({ size = 18, className = '' }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 100 100"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    className={className}
    aria-hidden="true"
  >
    <circle cx="50" cy="50" r="47" stroke="currentColor" strokeWidth="5" />
    <path
      d="M27 22V78M73 22V78M27 50H73"
      stroke="currentColor"
      strokeWidth="9"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);
