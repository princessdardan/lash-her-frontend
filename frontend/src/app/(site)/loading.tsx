export default function Loading() {
  return (
    <div className="min-h-[calc(100vh-200px)] flex items-center justify-center bg-background">
      <div className="flex flex-col items-center gap-4">
        <div className="h-10 w-10 animate-spin rounded-full border-4 border-lh-primary border-t-transparent" />
        <p className="text-lh-primary font-heading text-lg animate-pulse">Loading...</p>
      </div>
    </div>
  );
}
