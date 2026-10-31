export type FileType = 0 | 1 | 2 | 3;
export type TypeFilter = "all" | "system" | "ets2" | "ats";
export type StatusFilter = "all" | "needs" | "current" | "error";

export interface TmpFile {
  type: FileType;
  typeName: string;
  md5: string;
  fileSize: number;
  filePath: string;
  downloadUrl: string;
  updateTime: string;
}

export interface TmpApiResponse {
  code: number;
  msg: string;
  data: TmpFile[];
}

export type SyncStatus =
  | "idle"
  | "checking"
  | "current"
  | "outdated"
  | "missing"
  | "queued"
  | "downloading"
  | "verifying"
  | "installing"
  | "done"
  | "error";

export interface SyncItem extends TmpFile {
  state: SyncStatus;
  localSize?: number;
  localMd5?: string;
  error?: string;
  transferred?: number;
  speed?: number;
}

export interface ActivityEntry {
  id: number;
  time: string;
  message: string;
  level: "info" | "success" | "warning" | "error";
}

export interface ScanProgress {
  done: number;
  total: number;
  hashing: number;
}

export interface UpdateProgress {
  completed: number;
  total: number;
  currentNames: string[];
  bytesDone: number;
  bytesTotal: number;
  speed?: number;
  etaSeconds?: number | null;
  phase?: "downloading" | "retrying" | "verifying" | "installing" | "done";
  message?: string;
}
