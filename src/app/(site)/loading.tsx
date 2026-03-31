export default function Loading() {
  return (
    <div className="min-h-[calc(100vh-200px)] flex items-center justify-center bg-brand-pink">
      <div className="flex flex-col items-center gap-4">
        <div className="h-10 w-10 animate-spin rounded-full border-4 border-brand-red border-t-transparent" />
        <p className="text-brand-red font-serif text-lg animate-pulse">Loading...</p>
      </div>
    </div>
  );
}
