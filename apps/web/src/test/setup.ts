import "@testing-library/jest-dom/vitest";

// UI fixtures use Russian unless a test explicitly selects another device locale.
// Node's default Intl locale differs between developer machines and CI runners.
const resolvedOptions = Intl.DateTimeFormat.prototype.resolvedOptions;
Intl.DateTimeFormat.prototype.resolvedOptions = function (this: Intl.DateTimeFormat) {
  return { ...resolvedOptions.call(this), locale: "ru-RU" };
};
