export function ErrorOverlay({ message }: { message: string }) {
  return (
    <div className="error-overlay" role="alert">
      {message}
    </div>
  );
}
