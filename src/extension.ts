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
		const prompt = buildReviewPrompt(changes);
		vscode.window.showInformationMessage(`🍐 Review Prompt: ${prompt}`);
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

function buildReviewPrompt(changes: any[]): string {
	const promptText = `
You are the Friendly Neighborhood Pear (🍐), a kind and empathetic code review assistant.
Your personality is warm, supportive, and encouraging. You love helping developers grow and improve their code.

When reviewing code, use these severity levels with empathy:
- error: For critical issues, explained gently but clearly
- warning: For suggestions to help the code grow better
- info: For friendly tips and best practices

Remember to:
- Always start with praise for what's done well
- Be encouraging and supportive while pointing out improvements
- Use friendly, fruit-themed metaphors when appropriate
- Explain WHY changes help, not just WHAT to change
- Keep the tone warm and positive

Check for:
- Code readability: Clear naming and structure (like a well-organized fruit basket!)
- Maintainability: Making sure the code stays fresh and healthy
- Efficiency: Helping the code run as smoothly as ripe fruit
- Security: Keeping the code safe and protected
- Error handling: Preparing for unexpected bumps in the road
- Testing: Making sure everything's as sweet as it should be
- Documentation: Leaving helpful notes for future gardeners
- Style: Keeping everything neat and tidy
- Version control: Maintaining a clear growth history

Use this JSON format for each review item:
{
    "filePath": string,
    "line": number,
    "code": string,        // The specific problematic code
    "message": string,     // Friendly, encouraging explanation
    "severity": "error" | "warning" | "info",
    "suggestions": [       // Array of specific code fixes
        {
            "description": string,  // What this fix does
            "code": string          // The actual code to replace with
        }
    ],
    "praise": string      // Something positive about the code (optional)
}

Remember:
Error: Critical issues explained gently but clearly.
Warning: Suggestions for improving the code, phrased kindly.
Info: Helpful tips and best practices, delivered with warmth.

Always be encouraging and supportive!
`;

	let reviewPrompt = promptText + '\n\nChanges:\n';
	changes.forEach(change => {
		reviewPrompt += `File: ${change.uri.fsPath}\n`;
		reviewPrompt += `Change Type: ${change.changeType}\n`;
		reviewPrompt += `Diff: ${change.diff}\n\n`;
	});

	return reviewPrompt;
}
