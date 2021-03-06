/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import {TPromise} from 'vs/base/common/winjs.base';
import {Registry} from 'vs/platform/platform';
import types = require('vs/base/common/types');
import paths = require('vs/base/common/paths');
import {guessMimeTypes} from 'vs/base/common/mime';
import labels = require('vs/base/common/labels');
import URI from 'vs/base/common/uri';
import strings = require('vs/base/common/strings');
import assert = require('vs/base/common/assert');
import {EditorModel, EncodingMode, ConfirmResult} from 'vs/workbench/common/editor';
import {IEditorRegistry, Extensions, EditorDescriptor} from 'vs/workbench/browser/parts/editor/baseEditor';
import {BinaryEditorModel} from 'vs/workbench/common/editor/binaryEditorModel';
import {IFileOperationResult, FileOperationResult} from 'vs/platform/files/common/files';
import {FileEditorDescriptor} from 'vs/workbench/parts/files/browser/files';
import {ITextFileService, BINARY_FILE_EDITOR_ID, FILE_EDITOR_INPUT_ID, FileEditorInput as CommonFileEditorInput, AutoSaveMode, ModelState} from 'vs/workbench/parts/files/common/files';
import {CACHE, TextFileEditorModel} from 'vs/workbench/parts/files/common/editors/textFileEditorModel';
import {IWorkspaceContextService} from 'vs/workbench/services/workspace/common/contextService';
import {IInstantiationService} from 'vs/platform/instantiation/common/instantiation';

/**
 * A file editor input is the input type for the file editor of file system resources.
 */
export class FileEditorInput extends CommonFileEditorInput {

	// Do ref counting for all inputs that resolved to a model to be able to dispose when count = 0
	private static FILE_EDITOR_MODEL_CLIENTS: { [resource: string]: FileEditorInput[]; } = Object.create(null);

	// Keep promises that load a file editor model to avoid loading the same model twice
	private static FILE_EDITOR_MODEL_LOADERS: { [resource: string]: TPromise<EditorModel>; } = Object.create(null);

	private resource: URI;
	private mime: string;
	private preferredEncoding: string;

	private name: string;
	private description: string;
	private verboseDescription: string;

	/**
	 * An editor input who's contents are retrieved from file services.
	 */
	constructor(
		resource: URI,
		mime: string,
		preferredEncoding: string,
		@IInstantiationService private instantiationService: IInstantiationService,
		@IWorkspaceContextService private contextService: IWorkspaceContextService,
		@ITextFileService private textFileService: ITextFileService
	) {
		super();

		if (resource) {
			this.setResource(resource);
			this.setMime(mime || guessMimeTypes(this.resource.fsPath).join(', '));
			this.preferredEncoding = preferredEncoding;
		}
	}

	public setResource(resource: URI): void {
		if (resource.scheme !== 'file') {
			throw new Error('FileEditorInput can only handle file:// resources.');
		}

		this.resource = resource;

		// Reset resource dependent properties
		this.name = null;
		this.description = null;
		this.verboseDescription = null;
	}

	public getResource(): URI {
		return this.resource;
	}

	public getMime(): string {
		return this.mime;
	}

	public setMime(mime: string): void {
		assert.ok(mime, 'Editor input needs mime type');

		this.mime = mime;
	}

	public setPreferredEncoding(encoding: string): void {
		this.preferredEncoding = encoding;
	}

	public getEncoding(): string {
		let textModel = CACHE.get(this.resource);
		if (textModel) {
			return textModel.getEncoding();
		}

		return this.preferredEncoding;
	}

	public setEncoding(encoding: string, mode: EncodingMode): void {
		this.preferredEncoding = encoding;

		let textModel = CACHE.get(this.resource);
		if (textModel) {
			textModel.setEncoding(encoding, mode);
		}
	}

	public getTypeId(): string {
		return FILE_EDITOR_INPUT_ID;
	}

	public getName(): string {
		if (!this.name) {
			this.name = paths.basename(this.resource.fsPath);
		}

		return this.name;
	}

	public getDescription(verbose?: boolean): string {
		if (!verbose) {
			if (!this.description) {
				this.description = labels.getPathLabel(paths.dirname(this.resource.fsPath), this.contextService);
			}

			return this.description;
		}

		if (!this.verboseDescription) {
			this.verboseDescription = labels.getPathLabel(this.resource.fsPath);
		}

		return this.verboseDescription;
	}

	public isDirty(): boolean {
		const model = CACHE.get(this.resource);
		if (!model) {
			return false;
		}

		const state = model.getState();
		if (state === ModelState.CONFLICT || state === ModelState.ERROR) {
			return true; // always indicate dirty state if we are in conflict or error state
		}

		if (this.textFileService.getAutoSaveMode() === AutoSaveMode.AFTER_SHORT_DELAY) {
			return false; // fast auto save enabled so we do not declare dirty
		}

		return model.isDirty();
	}

	public confirmSave(): ConfirmResult {
		return this.textFileService.confirmSave([this.resource]);
	}

	public save(): TPromise<boolean> {
		return this.textFileService.save(this.resource);
	}

	public revert(): TPromise<boolean> {
		return this.textFileService.revert(this.resource);
	}

	public getPreferredEditorId(candidates: string[]): string {
		let editorRegistry = (<IEditorRegistry>Registry.as(Extensions.Editors));

		// Lookup Editor by Mime
		let descriptor: EditorDescriptor;
		let mimes = this.mime.split(',');
		for (let m = 0; m < mimes.length; m++) {
			let mime = strings.trim(mimes[m]);

			for (let i = 0; i < candidates.length; i++) {
				descriptor = editorRegistry.getEditorById(candidates[i]);

				if (types.isFunction((<FileEditorDescriptor>descriptor).getMimeTypes)) {
					let mimetypes = (<FileEditorDescriptor>descriptor).getMimeTypes();
					for (let j = 0; j < mimetypes.length; j++) {
						let mimetype = mimetypes[j];

						// Check for direct mime match
						if (mime === mimetype) {
							return descriptor.getId();
						}

						// Otherwise check for wildcard mime matches
						if (strings.endsWith(mimetype, '/*') && strings.startsWith(mime, mimetype.substring(0, mimetype.length - 1))) {
							return descriptor.getId();
						}
					}
				}
			}
		}

		// Otherwise use default editor
		return BINARY_FILE_EDITOR_ID;
	}

	public resolve(refresh?: boolean): TPromise<EditorModel> {
		let modelPromise: TPromise<EditorModel>;
		let resource = this.resource.toString();

		// Keep clients who resolved the input to support proper disposal
		let clients = FileEditorInput.FILE_EDITOR_MODEL_CLIENTS[resource];
		if (types.isUndefinedOrNull(clients)) {
			FileEditorInput.FILE_EDITOR_MODEL_CLIENTS[resource] = [this];
		} else if (this.indexOfClient() === -1) {
			FileEditorInput.FILE_EDITOR_MODEL_CLIENTS[resource].push(this);
		}

		// Check for running loader to ensure the model is only ever loaded once
		if (FileEditorInput.FILE_EDITOR_MODEL_LOADERS[resource]) {
			return FileEditorInput.FILE_EDITOR_MODEL_LOADERS[resource];
		}

		// Use Cached Model if present
		let cachedModel = CACHE.get(this.resource);
		if (cachedModel && !refresh) {
			modelPromise = TPromise.as<EditorModel>(cachedModel);
		}

		// Refresh Cached Model if present
		else if (cachedModel && refresh) {
			modelPromise = cachedModel.load();
			FileEditorInput.FILE_EDITOR_MODEL_LOADERS[resource] = modelPromise;
		}

		// Otherwise Create Model and Load
		else {
			modelPromise = this.createAndLoadModel();
			FileEditorInput.FILE_EDITOR_MODEL_LOADERS[resource] = modelPromise;
		}

		return modelPromise.then((resolvedModel: TextFileEditorModel | BinaryEditorModel) => {
			if (resolvedModel instanceof TextFileEditorModel) {
				CACHE.add(this.resource, resolvedModel); // Store into the text model cache unless this file is binary
			}
			FileEditorInput.FILE_EDITOR_MODEL_LOADERS[resource] = null; // Remove from pending loaders

			return resolvedModel;
		}, (error) => {
			FileEditorInput.FILE_EDITOR_MODEL_LOADERS[resource] = null; // Remove from pending loaders in case of an error

			return TPromise.wrapError(error);
		});
	}

	private indexOfClient(): number {
		if (!types.isUndefinedOrNull(FileEditorInput.FILE_EDITOR_MODEL_CLIENTS[this.resource.toString()])) {
			for (let i = 0; i < FileEditorInput.FILE_EDITOR_MODEL_CLIENTS[this.resource.toString()].length; i++) {
				let client = FileEditorInput.FILE_EDITOR_MODEL_CLIENTS[this.resource.toString()][i];
				if (client === this) {
					return i;
				}
			}
		}

		return -1;
	}

	private createAndLoadModel(): TPromise<EditorModel> {
		let descriptor = (<IEditorRegistry>Registry.as(Extensions.Editors)).getEditor(this);
		if (!descriptor) {
			throw new Error('Unable to find an editor in the registry for this input.');
		}

		// Optimistically create a text model assuming that the file is not binary
		let textModel = this.instantiationService.createInstance(TextFileEditorModel, this.resource, this.preferredEncoding);
		return textModel.load().then(() => textModel, (error) => {

			// In case of an error that indicates that the file is binary or too large, just return with the binary editor model
			if ((<IFileOperationResult>error).fileOperationResult === FileOperationResult.FILE_IS_BINARY || (<IFileOperationResult>error).fileOperationResult === FileOperationResult.FILE_TOO_LARGE) {
				textModel.dispose();

				let binaryModel = new BinaryEditorModel(this.resource, this.getName());
				return binaryModel.load();
			}

			// Bubble any other error up
			return TPromise.wrapError(error);
		});
	}

	public dispose(force?: boolean): void {

		// TextFileEditorModel
		let cachedModel = CACHE.get(this.resource);
		if (cachedModel) {

			// Only dispose if the last client called dispose() unless a forced dispose is triggered
			let index = this.indexOfClient();
			if (index >= 0) {

				// Remove from Clients List
				FileEditorInput.FILE_EDITOR_MODEL_CLIENTS[this.resource.toString()].splice(index, 1);

				// We typically never want to dispose a file editor model because this means loosing undo/redo history.
				// For that, we will keep the model around unless someone forces a dispose on the input. A forced dispose
				// can happen when the model has not been used for a while or was changed outside the application which
				// means loosing the undo redo history anyways.
				if (!force) {
					return;
				}

				// Dispose for real
				CACHE.dispose(this.resource);
			}
		}

		super.dispose();
	}

	public matches(otherInput: any): boolean {
		if (super.matches(otherInput) === true) {
			return true;
		}

		if (otherInput) {

			// Note that we can not test for the mime type here because we cache resolved file editor input models by resource. And
			// these models have a fixed mode association that can not be changed afterwards. As such, we always treat this input
			// equal if the resource is equal so that there is always just one text editor model (with undo hisotry etc.) around.
			//
			// !!! DO NOT CHANGE THIS ASSUMPTION !!!
			//
			return otherInput instanceof FileEditorInput && (<FileEditorInput>otherInput).resource.toString() === this.resource.toString();
		}

		return false;
	}

	/**
	 * Exposed so that other internal file API can access the list of all file editor inputs
	 * that have been loaded during the session.
	 */
	public static getAll(desiredFileOrFolderResource: URI): FileEditorInput[] {
		let inputsContainingResource: FileEditorInput[] = [];

		let clients = FileEditorInput.FILE_EDITOR_MODEL_CLIENTS;
		for (let resource in clients) {
			let inputs = clients[resource];

			// Check if path is identical or path is a folder that the content is inside
			if (paths.isEqualOrParent(resource, desiredFileOrFolderResource.toString())) {
				inputsContainingResource.push(...inputs);
			}
		}

		return inputsContainingResource;
	}
}