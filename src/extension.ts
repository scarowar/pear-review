// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import * as simpleGit from 'simple-git';
import * as fs from 'fs';
import * as path from 'path';

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {

	// Use the console to output diagnostic information (console.log) and errors (console.error)
	// This line of code will only be executed once when your extension is activated
	console.log('Congratulations, your extension "pear-review" is now active!');

	const reviewChangesDisposable = vscode.commands.registerCommand('pear-review.reviewChanges', async () => {
		const changes = await trackCodeChanges();
		vscode.window.showInformationMessage(`🍐 Review Changes: ${JSON.stringify(changes, null, 2)}`);
	});

	context.subscriptions.push(reviewChangesDisposable);
}

// This method is called when your extension is deactivated
export function deactivate() {}

async function trackCodeChanges(): Promise<any[]> {
	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (!workspaceFolders) {
		vscode.window.showErrorMessage('No workspace folder is open.');
		return [];
	}

	const workspacePath = workspaceFolders[0].uri.fsPath;
	const git = simpleGit.default(workspacePath);

	try {
		// Ensure Git repository is initialized
		const isRepo = await git.checkIsRepo();
		if (!isRepo) {
			vscode.window.showErrorMessage('No Git repository found in the workspace.');
			return [];
		}

		// Retrieve the list of changed files
		const status = await git.status();
		const changes = [];

		for (const file of status.files) {
			const filePath = path.join(workspacePath, file.path);
			const fileUri = vscode.Uri.file(filePath);
			let oldContent = '';
			let newContent = '';
			let diff = '';
			let changeType = '';

			try {
				// Read the new content of the file
				newContent = fs.readFileSync(filePath, 'utf8');
			} catch (error) {
				vscode.window.showWarningMessage(`Failed to read file: ${filePath}`);
				continue;
			}

			if (file.index === 'A') {
				changeType = 'added';
			} else if (file.index === 'M') {
				changeType = 'modified';
				try {
					// Get the old content of the file from the previous commit
					oldContent = await git.show([`HEAD:${file.path}`]);
				} catch (error) {
					vscode.window.showWarningMessage(`Failed to get previous version of file: ${filePath}`);
				}
			} else if (file.index === 'R') {
				changeType = 'renamed';
			}

			// Get the diff between the old and new content
			if (changeType === 'modified') {
				diff = await git.diff([`HEAD:${file.path}`, file.path]);
			}

			changes.push({
				uri: fileUri,
				oldContent,
				newContent,
				diff,
				changeType
			});
		}

		return changes;
	} catch (error) {
		if (error instanceof Error) {
			vscode.window.showErrorMessage(`Failed to track code changes: ${error.message}`);
		} else {
			vscode.window.showErrorMessage('Failed to track code changes: Unknown error');
		}
		return [];
	}
}
