// 릴리스를 감시할 패키지 레포와, 새 버전이 나오면 업데이트 PR을 만들 앱 레포 목록.
// 앱 레포에는 templates/update-dependency.yml 워크플로가 있어야 한다.
type Source = {
  packageName: string;
  consumers: string[];
};

const OWNER = "ssu-student-union";

const SOURCES: Record<string, Source> = {
  [`${OWNER}/passu-ui`]: {
    packageName: "@ssu-student-union/passu-ui",
    consumers: ["passu-frontend-admin", "passu-frontend-user"],
  },
};

// 앱 레포의 워크플로가 받는 repository_dispatch 이벤트 이름
const DISPATCH_EVENT = "dependency-release";

export type { Source };
export { DISPATCH_EVENT, OWNER, SOURCES };
