export interface BlobUrlMapping {
  landingFrames: string[];
  logo: string;
  uploadedAt: string;
  metadata: {
    totalFiles: number;
    totalSize: number;
    cdnUrl: string;
  };
}

declare module '@/config/blob-urls.json' {
  const value: BlobUrlMapping;
  export default value;
}
