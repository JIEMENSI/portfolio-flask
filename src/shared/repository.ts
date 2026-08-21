import type { Project, Version } from "./types";

export interface CreateProjectInput {
  name: string;
  isPublic: boolean;
  description?: string;
  remark?: string;
  groupName?: string;
  coverObjectKey?: string | null;
  shareId?: string;
  createdAt?: string;
}

export interface CreateVersionInput {
  shareId: string;
  changeNote: string;
  originalFilename: string;
  objectKey: string;
  fileSize: number;
  sha256: string;
  restoredFromVersionId: string | null;
  createdAt: string;
}

type ProjectRow = {
  id: string; share_id: string; name: string; description: string; remark: string;
  group_name: string; cover_object_key: string | null; is_public: number;
  current_version_id: string | null; next_version_number: number;
  status: Project["status"]; created_at: string; updated_at: string; trashed_at: string | null;
};

type VersionRow = {
  id: string; project_id: string; share_id: string; version_number: number;
  change_note: string; original_filename: string; object_key: string;
  file_size: number; sha256: string; restored_from_version_id: string | null;
  created_at: string; deleted_at: string | null;
};

const newId = () => crypto.randomUUID();
const newShareId = () => `${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;

const mapProject = (row: ProjectRow): Project => ({
  id: row.id, shareId: row.share_id, name: row.name, description: row.description,
  remark: row.remark, groupName: row.group_name, coverObjectKey: row.cover_object_key,
  isPublic: row.is_public === 1, currentVersionId: row.current_version_id,
  nextVersionNumber: row.next_version_number, status: row.status, createdAt: row.created_at,
  updatedAt: row.updated_at, trashedAt: row.trashed_at
});

const mapVersion = (row: VersionRow): Version => ({
  id: row.id, projectId: row.project_id, shareId: row.share_id,
  versionNumber: row.version_number, changeNote: row.change_note,
  originalFilename: row.original_filename, objectKey: row.object_key,
  fileSize: row.file_size, sha256: row.sha256,
  restoredFromVersionId: row.restored_from_version_id,
  createdAt: row.created_at, deletedAt: row.deleted_at
});

export class ProjectRepository {
  constructor(private readonly db: D1Database) {}

  async createProject(input: CreateProjectInput): Promise<Project> {
    const id = newId();
    const now = input.createdAt ?? new Date().toISOString();
    await this.db.prepare(`INSERT INTO projects
      (id, share_id, name, description, remark, group_name, cover_object_key, is_public, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, input.shareId ?? newShareId(), input.name, input.description ?? "", input.remark ?? "",
        input.groupName ?? "未分组", input.coverObjectKey ?? null, input.isPublic ? 1 : 0, now, now).run();
    return (await this.getProject(id))!;
  }

  async getProject(id: string): Promise<Project | null> {
    const row = await this.db.prepare("SELECT * FROM projects WHERE id = ?").bind(id).first<ProjectRow>();
    return row ? mapProject(row) : null;
  }

  async getProjectByShareId(shareId: string): Promise<Project | null> {
    const row = await this.db.prepare("SELECT * FROM projects WHERE share_id = ?").bind(shareId).first<ProjectRow>();
    return row ? mapProject(row) : null;
  }

  async listPublicProjects(): Promise<Project[]> {
    const result = await this.db.prepare("SELECT * FROM projects WHERE is_public = 1 AND status = 'active' ORDER BY updated_at DESC").all<ProjectRow>();
    return result.results.map(mapProject);
  }

  async createNextVersion(projectId: string, input: CreateVersionInput): Promise<Version> {
    const project = await this.getProject(projectId);
    if (!project) throw new Error("PROJECT_NOT_FOUND");
    const id = newId();
    const number = project.nextVersionNumber;
    await this.db.batch([
      this.db.prepare(`INSERT INTO versions
        (id, project_id, share_id, version_number, change_note, original_filename, object_key, file_size, sha256, restored_from_version_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(id, projectId, input.shareId, number, input.changeNote, input.originalFilename,
          input.objectKey, input.fileSize, input.sha256, input.restoredFromVersionId, input.createdAt),
      this.db.prepare(`UPDATE projects SET current_version_id = ?, next_version_number = ?, updated_at = ?
        WHERE id = ? AND next_version_number = ?`)
        .bind(id, number + 1, input.createdAt, projectId, number)
    ]);
    const row = await this.db.prepare("SELECT * FROM versions WHERE id = ?").bind(id).first<VersionRow>();
    if (!row) throw new Error("VERSION_CREATE_FAILED");
    return mapVersion(row);
  }

  async archiveProject(id: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db.prepare("UPDATE projects SET status = 'archived', updated_at = ? WHERE id = ?").bind(now, id).run();
  }
}
