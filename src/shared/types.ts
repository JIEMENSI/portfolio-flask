export interface Env {
  DB: D1Database;
  FILES: R2Bucket;
  PREVIEW_BASE_URL?: string;
  ADMIN_PASSWORD_HASH?: string;
  SESSION_PEPPER?: string;
  MIGRATION_TOKEN?: string;
}

export interface Project {
  id: string;
  shareId: string;
  name: string;
  description: string;
  remark: string;
  groupName: string;
  coverObjectKey: string | null;
  isPublic: boolean;
  currentVersionId: string | null;
  nextVersionNumber: number;
  status: "active" | "archived" | "trashed";
  createdAt: string;
  updatedAt: string;
  trashedAt: string | null;
}

export interface Version {
  id: string;
  projectId: string;
  shareId: string;
  versionNumber: number;
  changeNote: string;
  originalFilename: string;
  objectKey: string;
  fileSize: number;
  sha256: string;
  restoredFromVersionId: string | null;
  createdAt: string;
  deletedAt: string | null;
}
