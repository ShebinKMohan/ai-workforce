/**
 * Loading validated configuration and task documents from disk.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  type AgentConfigFile,
  ContractValidationError,
  type TaskContract,
  validateAgentConfig,
  validateTaskContract,
} from './contracts.js';

export interface LoadedAgentConfig {
  readonly path: string;
  readonly config: AgentConfigFile;
  /** Raw file text, retained so a run can snapshot exactly what was loaded. */
  readonly raw: string;
}

function readJsonDocument(filePath: string, contractName: string): { raw: string; value: unknown } {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const reason = code === 'ENOENT' ? 'file not found' : code === 'EISDIR' ? 'path is a directory' : String((error as Error).message);
    throw new ContractValidationError(contractName, [{ path: filePath, message: `cannot read file (${reason})` }]);
  }
  try {
    return { raw, value: JSON.parse(raw) as unknown };
  } catch (error) {
    throw new ContractValidationError(contractName, [
      { path: filePath, message: `not valid JSON (${(error as Error).message}); comments and trailing commas are not allowed` },
    ]);
  }
}

/** Load and validate an agent configuration file. Throws ContractValidationError with actionable issues. */
export function loadAgentConfigFile(filePath: string): LoadedAgentConfig {
  const absolute = path.resolve(filePath);
  const { raw, value } = readJsonDocument(absolute, 'agent configuration');
  return { path: absolute, config: validateAgentConfig(value), raw };
}

/** Load and validate a task contract file. */
export function loadTaskContractFile(filePath: string): TaskContract {
  const absolute = path.resolve(filePath);
  return validateTaskContract(readJsonDocument(absolute, 'task contract').value);
}
