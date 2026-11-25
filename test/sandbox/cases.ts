import { DEFAULT_BYLAWS, cloneBylaws } from '../../src/bylaws.js';
import type { Bylaws, BylawsLoad } from '../../src/types.js';
import type { NetworkPolicy, PathKind, PlanOptions } from '../../src/sandbox/index.js';

export const HOME_D = '/Users/alex';
export const HOME_L = '/home/alex';
export const HOME_W = 'C:\\Users\\alex';

export interface PlanCase {
  name: string;
  platform: string;
  root: string;
  opts?: Partial<PlanOptions>;
  bylaws?: Bylaws | BylawsLoad;
  expect: {
    ok: boolean;
    error?: RegExp;
    root?: string;
    enforced?: boolean;
    writableHas?: string[];
    writableLacks?: string[];
    denyReadHas?: string[];
    denyReadLacks?: string[];
    denyWriteHas?: string[];
    network?: NetworkPolicy;
    seatbeltHas?: string[];
    /** Each inner list must appear as a contiguous run in the bwrap arguments. */
    bwrapSeq?: string[][];
    bwrapLacks?: string[];
    noteMatch?: RegExp;
    srtDomains?: string[];
  };
}

const allExist = (p: string): PathKind => (/\.(kube|docker)\/|netrc|npmrc|pypirc|credentials|token|pgpass|cnf|\.env$|\.git\/config|\.ya?ml$|\.json$/.test(p) ? 'file' : 'dir');
const noneExist = (): PathKind => 'missing';

const secretsAllow = cloneBylaws(DEFAULT_BYLAWS);
secretsAllow.guards.secrets.read = 'allow';
const withSandboxSection = Object.assign(cloneBylaws(DEFAULT_BYLAWS), { sandbox: { network: { allow_hosts: ['registry.npmjs.org'] } } });

export const PLAN_CASES: PlanCase[] = [
  {
    name: 'macOS basic project',
    platform: 'darwin',
    root: '/Users/alex/proj',
    expect: {
      ok: true,
      enforced: true,
      root: '/Users/alex/proj',
      writableHas: ['/Users/alex/proj', '/private/tmp', '/private/var/tmp'],
      denyReadHas: ['/Users/alex/.ssh', '/Users/alex/.aws', '/Users/alex/.netrc'],
      denyWriteHas: ['/Users/alex/proj/.git/hooks', '/Users/alex/proj/openmorals.yaml', '/Users/alex/proj/.claude/settings.json'],
      network: { mode: 'off' },
      seatbeltHas: ['(allow default)', '(deny network*)', '(require-not (subpath "/Users/alex/proj"))', '(subpath "/Users/alex/.ssh")', '(regex #"/\\.env$")', '(regex #"\\.pem$")'],
      srtDomains: [],
    },
  },
  { name: 'macOS path with spaces', platform: 'darwin', root: '/Users/alex/My Projects/app one', expect: { ok: true, root: '/Users/alex/My Projects/app one', seatbeltHas: ['(require-not (subpath "/Users/alex/My Projects/app one"))'] } },
  { name: 'macOS root with .. is normalised', platform: 'darwin', root: '/Users/alex/proj/../other/./x', expect: { ok: true, root: '/Users/alex/other/x' } },
  { name: 'macOS trailing slash is dropped', platform: 'darwin', root: '/Users/alex/proj/', expect: { ok: true, root: '/Users/alex/proj' } },
  { name: 'macOS /tmp root becomes /private/tmp (symlink-looking path)', platform: 'darwin', root: '/tmp/work', expect: { ok: true, root: '/private/tmp/work', writableLacks: ['/tmp/work'] } },
  { name: 'macOS /var/folders root becomes /private/var', platform: 'darwin', root: '/var/folders/ab/T/p', expect: { ok: true, root: '/private/var/folders/ab/T/p' } },
  { name: 'macOS relative root is refused', platform: 'darwin', root: 'proj', expect: { ok: false, error: /absolute darwin path/ } },
  { name: 'macOS given a Windows drive path is refused', platform: 'darwin', root: 'C:\\proj', expect: { ok: false, error: /backslash|absolute/ } },
  { name: 'file system root is refused', platform: 'darwin', root: '/', expect: { ok: false, error: /file system root/ } },
  { name: 'home as root is refused', platform: 'darwin', root: '/Users/alex', expect: { ok: false, error: /home directory/ } },
  { name: 'a parent of home as root is refused', platform: 'darwin', root: '/Users', expect: { ok: false, error: /home directory/ } },
  { name: 'home reached through .. is refused', platform: 'darwin', root: '/Users/alex/proj/..', expect: { ok: false, error: /home directory/ } },
  { name: 'double quote in a path is refused', platform: 'darwin', root: '/Users/alex/a"b', expect: { ok: false, error: /double quote/ } },
  { name: 'newline in a path is refused', platform: 'darwin', root: '/Users/alex/a\nb', expect: { ok: false, error: /control character/ } },
  { name: 'empty root is refused', platform: 'linux', root: '', expect: { ok: false, error: /empty/ } },
  {
    name: 'Linux basic project, everything exists',
    platform: 'linux',
    root: '/home/alex/proj',
    opts: { home: HOME_L, probe: allExist },
    expect: {
      ok: true,
      enforced: true,
      writableHas: ['/home/alex/proj', '/tmp'],
      bwrapSeq: [
        ['--unshare-all'],
        ['--ro-bind', '/', '/'],
        ['--bind', '/home/alex/proj', '/home/alex/proj'],
        ['--tmpfs', '/home/alex/.ssh', '--remount-ro', '/home/alex/.ssh'],
        ['--ro-bind', '/dev/null', '/home/alex/.netrc'],
        ['--ro-bind', '/home/alex/proj/.git/hooks', '/home/alex/proj/.git/hooks'],
        ['--chdir', '/home/alex/proj'],
      ],
      bwrapLacks: ['--share-net'],
      noteMatch: /concrete paths/,
    },
  },
  { name: 'Linux, nothing exists: missing paths are skipped', platform: 'linux', root: '/home/alex/proj', opts: { home: HOME_L, probe: noneExist }, expect: { ok: true, bwrapLacks: ['--tmpfs', '/dev/null'] } },
  { name: 'Linux without a probe says so', platform: 'linux', root: '/home/alex/proj', opts: { home: HOME_L }, expect: { ok: true, noteMatch: /not probed/, bwrapSeq: [['--tmpfs', '/home/alex/.ssh']] } },
  {
    name: 'Linux project .env is masked after the project bind',
    platform: 'linux',
    root: '/home/alex/proj',
    opts: { home: HOME_L, probe: allExist, projectSecretFiles: ['.env', '/home/alex/proj/config/.env'] },
    expect: { ok: true, bwrapSeq: [['--bind', '/home/alex/proj', '/home/alex/proj'], ['--ro-bind', '/dev/null', '/home/alex/proj/.env']], denyReadHas: ['/home/alex/proj/config/.env'] },
  },
  { name: 'Linux project secret file outside the root is refused', platform: 'linux', root: '/home/alex/proj', opts: { home: HOME_L, projectSecretFiles: ['../other/.env'] }, expect: { ok: false, error: /inside the project root/ } },
  {
    name: 'Windows drive path: plan only, not enforced',
    platform: 'win32',
    root: 'C:\\Users\\alex\\proj',
    opts: { home: HOME_W },
    expect: { ok: true, enforced: false, root: 'C:\\Users\\alex\\proj', writableHas: ['C:\\Users\\alex\\proj'], denyReadHas: ['C:\\Users\\alex\\.ssh'], noteMatch: /plan only/ },
  },
  { name: 'Windows forward slashes and .. are normalised', platform: 'win32', root: 'c:/Users/alex/proj/../x', opts: { home: HOME_W }, expect: { ok: true, root: 'c:\\Users\\alex\\x' } },
  { name: 'Windows UNC path', platform: 'win32', root: '\\\\server\\share\\proj', opts: { home: HOME_W }, expect: { ok: true, root: '\\\\server\\share\\proj' } },
  { name: 'Windows drive root is refused', platform: 'win32', root: 'C:\\', opts: { home: HOME_W }, expect: { ok: false, error: /file system root/ } },
  { name: 'Windows drive-relative path is refused', platform: 'win32', root: '\\proj', opts: { home: HOME_W }, expect: { ok: false, error: /absolute win32/ } },
  { name: 'Windows home in another case is still home', platform: 'win32', root: 'c:\\users\\ALEX', opts: { home: HOME_W }, expect: { ok: false, error: /home directory/ } },
  { name: 'Windows relative path is refused', platform: 'win32', root: 'proj', opts: { home: HOME_W }, expect: { ok: false, error: /absolute win32/ } },
  { name: 'empty allow lists: network off, nothing extra', platform: 'darwin', root: '/Users/alex/proj', opts: { sandbox: { network: { allow_hosts: [] }, write: { allow: [] }, read: { deny: [] } } }, expect: { ok: true, network: { mode: 'off' }, srtDomains: [] } },
  {
    name: 'listed hosts reach srt only; seatbelt keeps the network off',
    platform: 'darwin',
    root: '/Users/alex/proj',
    opts: { sandbox: { network: { allow_hosts: ['GitHub.com', '*.npmjs.org', 'github.com'] } } },
    expect: { ok: true, network: { mode: 'hosts', hosts: ['github.com', '*.npmjs.org'] }, srtDomains: ['github.com', '*.npmjs.org'], seatbeltHas: ['(deny network*)'], noteMatch: /cannot filter by host/ },
  },
  { name: 'a bare * host is refused', platform: 'darwin', root: '/Users/alex/proj', opts: { sandbox: { network: { allow_hosts: ['*'] } } }, expect: { ok: false, error: /not a host name/ } },
  { name: 'an IP address host is refused', platform: 'darwin', root: '/Users/alex/proj', opts: { sandbox: { network: { allow_hosts: ['10.0.0.1'] } } }, expect: { ok: false, error: /not a host name/ } },
  { name: 'a host with a path is refused', platform: 'darwin', root: '/Users/alex/proj', opts: { sandbox: { network: { allow_hosts: ['example.com/upload'] } } }, expect: { ok: false, error: /not a host name/ } },
  { name: 'an unknown key in the sandbox section is refused', platform: 'darwin', root: '/Users/alex/proj', opts: { sandbox: { network: { allow_hosts: [] }, shell: true } as never }, expect: { ok: false, error: /unknown key/ } },
  { name: 'making ~/.ssh writable is refused', platform: 'darwin', root: '/Users/alex/proj', opts: { sandbox: { write: { allow: ['~/.ssh/tmp'] } } }, expect: { ok: false, error: /read-denied/ } },
  { name: 'making ~/.SSH writable is refused (case-insensitive on macOS)', platform: 'darwin', root: '/Users/alex/proj', opts: { sandbox: { write: { allow: ['/USERS/ALEX/.SSH'] } } }, expect: { ok: false, error: /read-denied/ } },
  { name: 'making home writable is refused', platform: 'darwin', root: '/Users/alex/proj', opts: { sandbox: { write: { allow: ['~'] } } }, expect: { ok: false, error: /home directory/ } },
  { name: '~user paths are refused', platform: 'darwin', root: '/Users/alex/proj', opts: { sandbox: { write: { allow: ['~bob/cache'] } } }, expect: { ok: false, error: /cannot be resolved/ } },
  { name: 'relative writable path with .. resolves against the root', platform: 'darwin', root: '/Users/alex/proj', opts: { sandbox: { write: { allow: ['../shared cache'] } } }, expect: { ok: true, writableHas: ['/Users/alex/shared cache'] } },
  { name: 'a writable /tmp path is folded into /private/tmp', platform: 'darwin', root: '/Users/alex/proj', opts: { sandbox: { write: { allow: ['/tmp/cache'] } } }, expect: { ok: true, writableLacks: ['/tmp/cache', '/private/tmp/cache'], writableHas: ['/private/tmp'] } },
  { name: 'extra read-denied path relative to the root', platform: 'darwin', root: '/Users/alex/proj', opts: { sandbox: { read: { deny: ['secrets/', '~/Documents/tax'] } } }, expect: { ok: true, denyReadHas: ['/Users/alex/proj/secrets', '/Users/alex/Documents/tax'], seatbeltHas: ['(subpath "/Users/alex/proj/secrets")'] } },
  { name: 'denying reads of / is refused', platform: 'darwin', root: '/Users/alex/proj', opts: { sandbox: { read: { deny: ['/'] } } }, expect: { ok: false, error: /whole file system/ } },
  { name: 'secrets.read allow drops the built-in credential paths', platform: 'darwin', root: '/Users/alex/proj', bylaws: secretsAllow, expect: { ok: true, denyReadLacks: ['/Users/alex/.ssh'], noteMatch: /secrets\.read is allow/ } },
  { name: 'invalid bylaws: no plan from the defaults (0.17.0)', platform: 'darwin', root: '/Users/alex/proj', bylaws: { ok: false, error: 'version: required; guards: unknown key', source: 'openmorals.yaml' }, expect: { ok: false, error: /^the bylaws file openmorals\.yaml is invalid \(version: required\); no sandbox plan is made from the defaults.*run openmorals validate$/ } },
  { name: 'a sandbox section on the bylaws object is read', platform: 'linux', root: '/home/alex/proj', opts: { home: HOME_L, probe: allExist }, bylaws: withSandboxSection, expect: { ok: true, network: { mode: 'hosts', hosts: ['registry.npmjs.org'] }, srtDomains: ['registry.npmjs.org'], bwrapLacks: ['--share-net'] } },
  { name: 'unsupported platform is refused', platform: 'freebsd', root: '/home/alex/proj', expect: { ok: false, error: /no sandbox for platform/ } },
  { name: 'a relative temp directory is refused', platform: 'darwin', root: '/Users/alex/proj', opts: { tmpDirs: ['tmp'] }, expect: { ok: false, error: /must be absolute/ } },
];
