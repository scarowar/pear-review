import * as vscode from 'vscode';
import * as simpleGit from 'simple-git';
import * as fs from 'fs';
import * as path from 'path';

interface ReviewComment {
    filePath: string;
    line: number;
    code: string;
    message: string;
    severity: 'error' | 'warning' | 'info';
    suggestions: Array<{
        description: string;
        code: string;
    }>;
    praise?: string;
}

export function activate(context: vscode.ExtensionContext) {
    console.log('Congratulations, your extension "pear-review" is now active!');

    const reviewChangesDisposable = vscode.commands.registerCommand('pear-review.reviewChanges', async () => {
        const output = vscode.window.createOutputChannel("Pear Review");
        output.show();
        output.appendLine('Starting code review...');

        try {
            const changes = await trackCodeChanges();
            output.appendLine(`Found ${changes.length} changed file(s)`);

            const prompt = buildReviewPrompt(changes);
            output.appendLine('Generated review prompt');
            output.appendLine('Sending request to language model...');

            const reviewComments = await generateReviewComments(prompt);
            output.appendLine('Received response from language model');

            const parsedComments = await parseChatResponse(reviewComments);
            output.appendLine(`Parsed ${parsedComments.length} review comment(s)`);

            if (parsedComments.length === 0) {
                vscode.window.showWarningMessage('No review comments were generated. Please try again.');
            } else {
				console.log("Prettified JSON", JSON.stringify(parsedComments, null, 2));
                vscode.window.showInformationMessage(`🍐 Generated ${parsedComments.length} review comments!`);
            }
        } catch (error) {
            output.appendLine(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
            vscode.window.showErrorMessage('Failed to generate review comments. Check output for details.');
        }
    });

    context.subscriptions.push(reviewChangesDisposable);
}

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
        const isRepo = await git.checkIsRepo();
        if (!isRepo) {
            vscode.window.showErrorMessage('No Git repository found in the workspace.');
            return [];
        }

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
                    oldContent = await git.show([`HEAD:${file.path}`]);
                } catch (error) {
                    vscode.window.showWarningMessage(`Failed to get previous version of file: ${filePath}`);
                }
            } else if (file.index === 'R') {
                changeType = 'renamed';
            }

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
        vscode.window.showErrorMessage(`Failed to track code changes: ${error instanceof Error ? error.message : 'Unknown error'}`);
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
    "code": string,
    "message": string,
    "severity": "error" | "warning" | "info",
    "suggestions": [
        {
            "description": string,
            "code": string
        }
    ],
    "praise": string
}

Remember:
Error: Critical issues explained gently but clearly.
Warning: Suggestions for improving the code, phrased kindly.
Info: Helpful tips and best practices, delivered with warmth.

Always be encouraging and supportive!
`;

    let reviewPrompt = promptText + '\n\nFiles to review:\n';

    changes.forEach(change => {
        const relativePath = vscode.workspace.asRelativePath(change.uri);
        reviewPrompt += `\n=== ${relativePath} (${change.changeType}) ===\n`;

        const fileExtension = path.extname(relativePath).replace('.', '') || '';
        reviewPrompt += `File extension: ${fileExtension}\n`;

        const lines = change.newContent.split('\n');
        reviewPrompt += `Total lines: ${lines.length}\n\n`;
        lines.forEach((line: string, index: number) => {
            reviewPrompt += `${index + 1}: ${line}\n`;
        });

        if (change.diff) {
            reviewPrompt += '\nDiff:\n';
            change.diff.split('\n').forEach((line: string) => {
                if (line.startsWith('+')) {
                    reviewPrompt += `Added: ${line.substring(1)}\n`;
                } else if (line.startsWith('-')) {
                    reviewPrompt += `Removed: ${line.substring(1)}\n`;
                }
            });
        }

        reviewPrompt += '\n';
    });

    return reviewPrompt;
}

async function generateReviewComments(prompt: string): Promise<vscode.LanguageModelChatResponse> {
    let [model] = await vscode.lm.selectChatModels({
        vendor: 'copilot',
        family: 'gpt-4o'
    });

    if (!model) {
        throw new Error('No language model available');
    }

    const messages = [
        vscode.LanguageModelChatMessage.User(prompt)
    ];

    return model.sendRequest(
        messages,
        {},
        new vscode.CancellationTokenSource().token
    );
}

async function parseChatResponse(chatResponse: vscode.LanguageModelChatResponse): Promise<ReviewComment[]> {
    const output = vscode.window.createOutputChannel("Pear Review Parser");
    let accumulatedResponse = '';
    const parsedComments: ReviewComment[] = [];

    try {
        for await (const fragment of chatResponse.text) {
            accumulatedResponse += fragment;
            output.appendLine(`Received fragment: ${fragment}`);

            if (fragment.includes('}')) {
                try {
                    const matches = accumulatedResponse.match(/\{[^{]*\}/g);
                    if (matches) {
                        for (const match of matches) {
                            try {
                                const reviewComment: ReviewComment = JSON.parse(match);
                                if (reviewComment.filePath && reviewComment.line && 
                                    reviewComment.message && reviewComment.severity) {
                                    parsedComments.push(reviewComment);
                                    output.appendLine(`Successfully parsed comment for ${reviewComment.filePath}`);
                                }
                            } catch (parseError) {
                                output.appendLine(`Failed to parse JSON: ${match}`);
                            }
                        }
                        accumulatedResponse = accumulatedResponse.replace(/\{[^{]*\}/g, '');
                    }
                } catch (e) {
                    output.appendLine(`Error processing fragment: ${e instanceof Error ? e.message : 'Unknown error'}`);
                }
            }
        }

        if (accumulatedResponse.trim()) {
            try {
                const reviewComment: ReviewComment = JSON.parse(accumulatedResponse);
                if (reviewComment.filePath && reviewComment.line && 
                    reviewComment.message && reviewComment.severity) {
                    parsedComments.push(reviewComment);
                }
            } catch (e) {
                output.appendLine(`Failed to parse remaining response: ${accumulatedResponse}`);
            }
        }
    } catch (error) {
        output.appendLine(`Error in parseChatResponse: ${error instanceof Error ? error.message : 'Unknown error'}`);
        throw error;
    }

    return parsedComments;
}