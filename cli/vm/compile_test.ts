import { expect } from "chai";
import { suite, test } from "df/testing";

import { restricted_fs_path } from "df/cli/vm/compile";

suite('restricted_fs_path', () => {
  const TEST_CASES = [
    {
      name: 'file path inside project directory relative',
      projectDir: '/project',
      filePath: 'dir/file.txt',
      expectedPath: '/project/dir/file.txt',
    },
    {
      name: 'file path inside project directory absolute',
      projectDir: '/project',
      filePath: '/dir/file.txt',
      expectedPath: '/project/dir/file.txt',
    },
    {
      name: 'file path inside project directory',
      projectDir: '/project',
      filePath: '/project',
      expectedPath: '/project/project',
    },
    {
      name: 'file path outside project directory',
      projectDir: '/project',
      filePath: 'outside/../../../dir/file.txt',
      expectedPath: '/project/dir/file.txt',
    },
    {
      name: 'project directory relative',
      projectDir: './parent/../project',
      filePath: 'outside/../../../dir/file.txt',
      expectedPath: 'project/dir/file.txt',
    },
  ];

  for (const testCase of TEST_CASES) {
    test(testCase.name, () => {
      expect(restricted_fs_path(testCase.projectDir, testCase.filePath)).to.equal(testCase.expectedPath);
    });
  }
});
