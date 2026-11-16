const DEPENDENCIES_PREFIX = "// nibble-dependencies: ";
const DEPENDENCIES_COMMENT = /^\/\/ nibble-dependencies: (.*)$/m;
const DEPENDENCY_SEPARATOR = ",";

export const encodeDependencies = (packageIds: Iterable<string>): string =>
  DEPENDENCIES_PREFIX + [...packageIds].sort().join(DEPENDENCY_SEPARATOR);

export const decodeDependencies = (content: string): string[] => {
  const encodedPackageIds = content.match(DEPENDENCIES_COMMENT)?.[1];
  if (!encodedPackageIds) {
    return [];
  }
  return encodedPackageIds.split(DEPENDENCY_SEPARATOR);
};
