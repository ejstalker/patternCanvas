/** Runtime object-URL resolver for externalized image assets. */

export class AssetUrlResolver {
  private urls = new Map<string, string>();

  resolve(assetId: string, blob: Blob): string {
    const existing = this.urls.get(assetId);
    if (existing) return existing;
    const url = URL.createObjectURL(blob);
    this.urls.set(assetId, url);
    return url;
  }

  get(assetId: string): string | null {
    return this.urls.get(assetId) ?? null;
  }

  revoke(assetId: string): void {
    const url = this.urls.get(assetId);
    if (!url) return;
    URL.revokeObjectURL(url);
    this.urls.delete(assetId);
  }

  revokeAll(): void {
    for (const url of this.urls.values()) {
      URL.revokeObjectURL(url);
    }
    this.urls.clear();
  }

  /** Replace URLs for assets no longer referenced by the active project. */
  retain(assetIds: Iterable<string>): void {
    const keep = new Set(assetIds);
    for (const id of [...this.urls.keys()]) {
      if (!keep.has(id)) this.revoke(id);
    }
  }
}
