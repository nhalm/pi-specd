export interface WorkItem {
  spec: string;
  description: string;
  blocked?: string;
  completed: boolean;
}

export interface Spec {
  name: string;
  items: WorkItem[];
}

export interface WorkList {
  specs: Spec[];
}

export const EMPTY_WORK_LIST: WorkList = {
  specs: [],
};
