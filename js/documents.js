/*globals $,OC,fileDownloadPath,t,document,odf,alert,require,dojo,runtime,Handlebars */

$.widget('oc.documentGrid', {
	options : {
		context : '.documentslist',
		documents : {},
		sessions : {},
		members : {}
	},

	render : function(fileId) {
		var that = this;
		jQuery.when(this._load(fileId))
			.then(function(){
				that._render();
				documentsMain.renderComplete = true;
			});
	},

	_load : function(fileId) {
		// Handle guest user case (let users which are able to write set their name)
		if (!richdocuments_directEdit && window.top.oc_current_user == null && this._getGuestNameCookie() == ''
				&& (richdocuments_permissions & OC.PERMISSION_UPDATE)) {
			$('#documentslist').remove();

			var text = document.createElement('div');
			$(text).attr('style', 'margin: 0 auto; margin-top: 100px; text-align: center;');

			var para = t('richdocuments', 'Please choose your nickname to continue as guest user.');
			text.innerHTML = para;


			var div = document.createElement('div');
			$(div).attr('style', 'margin: 0 auto; width: 195px;');
			var nick = '<input type="text" placeholder="' + t('richdocuments', 'Nickname') + '" id="nickname" style="border-right:none; border-top-right-radius: 0; border-bottom-right-radius: 0">';
			var btn = '<input style="border-left:none; border-top-left-radius: 0; border-bottom-left-radius: 0; margin-left: -3px" type="button" id="btn" type="button" value="' + t('richdocuments', 'Set') + '">';
			div.innerHTML = nick + btn;

			$('#documents-content').prepend(div);
			$('#documents-content').prepend(text);
			var that = this;
			$('#nickname').keyup(function(event) {
				if (event.which === 13) {
					that._setGuestNameCookie();
				}
			});
			$('#btn').click(that._setGuestNameCookie);
			$('#preview').hide();
			// return such that the editor rendering is skipped. The (parent) page
			// will be reloaded with the cookie set when the user submits the form.
			return;
		}

		// standard case, render the editor
		documentsMain.initSession();
	},

	_getGuestNameCookie: function() {
		var name = 'guestUser=';
		var decodedCookie = decodeURIComponent(document.cookie);
		var cookieArr = decodedCookie.split(';');
		for (var i = 0; i < cookieArr.length; i++) {
			var c = cookieArr[i];
			while (c.charAt(0) == ' ') {
				c = c.substring(1);
			}
			if (c.indexOf(name) == 0) {
				return c.substring(name.length, c.length);
			}
		}
		return '';
	},

	_setGuestNameCookie: function() {
		var username = $('#nickname').val();

		if (username != '') {
			document.cookie = 'guestUser=' + encodeURIComponent(username) + '; path=/';
		}

		location.reload(true);
	},

	_render : function(data) {
		var that = this,
			documents = data && data.documents || this.options.documents,
			sessions = data && data.sessions || this.options.sessions,
			members = data && data.members || this.options.members,
			hasDocuments = false
		;

		$(this.options.context + ' .document:not(.template,.progress)').remove();

		if (documentsMain.loadError) {
			$(this.options.context).after('<div id="errormessage">'
				+ '<p>' + documentsMain.loadErrorMessage + '</p><p>'
				+ documentsMain.loadErrorHint
				+ '</p></div>'
			);
			return;
		}
	}
});

$.widget('oc.documentOverlay', {
	options : {
		parent : 'document.body'
	},
	_create : function (){
		$(this.element).hide().appendTo(document.body);
	},
	show : function(){
		$(this.element).fadeIn('fast');
	},
	hide : function(){
		$(this.element).fadeOut('fast');
	}
});

// Polyfill for Number.isInteger
// FIXME: Remove once Nextcloud 15 is the minimum required version
// since es6-shim is shipped for that
Number.isInteger = Number.isInteger || function(value) {
	return typeof value === 'number' &&
		isFinite(value) &&
		Math.floor(value) === value;
};

var documentsMain = {
	isEditorMode : false,
	isViewerMode: false,
	ready :false,
	fileName: null,
	baseName: null,
	canShare : false,
	canEdit: false,
	loadError : false,
	loadErrorMessage : '',
	loadErrorHint : '',
	renderComplete: false, // false till page is rendered with all required data about the document(s)
	toolbar : '<div id="ocToolbar"><div id="ocToolbarInside"></div><span id="toolbar" class="claro"></span></div>',
	$deferredVersionRestoreAck: null,
	wopiClientFeatures: null,

	// generates docKey for given fileId
	_generateDocKey: function(wopiFileId) {
		var ocurl = OC.generateUrl('apps/richdocuments/wopi/files/{file_id}', {file_id: wopiFileId});
		if (richdocuments_canonical_webroot) {
			if (!richdocuments_canonical_webroot.startsWith('/'))
				richdocuments_canonical_webroot = '/' + richdocuments_canonical_webroot;

			ocurl = ocurl.replace(OC.getRootPath(), richdocuments_canonical_webroot);
		}

		return ocurl;
	},

	UI : {
		/* Editor wrapper HTML */
		container : '<div id="mainContainer" class="claro">' +
					'</div>',

		viewContainer: '<div id="revViewerContainer" class="claro">' +
						'<div id="revViewer"></div>' +
						'</div>',

		/* Previous window title */
		mainTitle : '',
		/* Number of revisions already loaded */
		revisionsStart: 0,

		/* Views: people currently editing the file */
		views: {},

		init : function(){
			documentsMain.UI.mainTitle = parent.document.title;

			//Add the avatar toolbar if possible
			var headerRight = parent.$('#header .header-right');
			headerRight.prepend($('<div id="richdocuments-avatars">'));
			this.addVersionSidebarEvents();
		},

		renderAvatars: function() {
			var avatardiv = parent.$('#header .header-right #richdocuments-avatars');
			avatardiv.empty();
			var users = [];
			// Add new avatars
			for (var viewId in this.views) {
				var view = this.views[viewId];
				if (view.UserId === parent.OC.currentUser) {
					continue;
				}
				if (view.UserId !== "" && users.indexOf(view.UserId) > -1) {
					continue;
				}
				var userName = view.UserName !== '' ? view.UserName : t('richdocuments', 'Guest');
				users.push(view.UserId);
				var avatarContainer = $('<div class="richdocuments-avatar"><div class="avatar" title="' + view.UserName + '" data-user="' + view.UserId + '"></div></div>');
				var avatar = avatarContainer.find('.avatar');
				avatardiv.append(avatarContainer);
				if (view.ReadOnly === '1') {
					avatarContainer.addClass('read-only');
					$(avatar).attr('title', userName + ' ' + t('richdocuments', '(read only)'));
				} else {
					$(avatar).attr('title', userName);
				}

				$(avatar).avatar(view.UserId, 32);
				if (parent.OC.currentUser !== null && view.UserId !== '') {
					$(avatar).contactsMenu(view.UserId, 0, avatarContainer);
				}
			};
			parent.$('.richdocuments-avatar .avatar').tooltip({placement: 'bottom', container: '#header'});
		},

		showViewer: function(fileId, title){
			// remove previous viewer, if open, and set a new one
			if (documentsMain.isViewerMode) {
				$('#revViewer').remove();
				$('#revViewerContainer').prepend($('<div id="revViewer">'));
			} else {
				this.addCurrentVersion();
			}

			// WOPISrc - URL that loolwsd will access (ie. pointing to ownCloud)
			var wopiurl = window.location.protocol + '//' + window.location.host + OC.generateUrl('apps/richdocuments/wopi/files/{file_id}', {file_id: fileId});
			var wopisrc = encodeURIComponent(wopiurl);

			// urlsrc - the URL from discovery xml that we access for the particular
			// document; we add various parameters to that.
			// The discovery is available at
			//   https://<loolwsd-server>:9980/hosting/discovery
			var urlsrc = documentsMain.urlsrc +
				"WOPISrc=" + wopisrc +
				"&title=" + encodeURIComponent(title) +
				"&lang=" + OC.getLocale().replace('_', '-') + // loleaflet expects a BCP47 language tag syntax
				"&permission=readonly";

			// access_token - must be passed via a form post
			var access_token = encodeURIComponent(documentsMain.token);

			// form to post the access token for WOPISrc
			var form = '<form id="loleafletform_viewer" name="loleafletform_viewer" target="loleafletframe_viewer" action="' + urlsrc + '" method="post">' +
			  '<input name="access_token" value="' + access_token + '" type="hidden"/></form>';

			// iframe that contains the Collabora Online Viewer
			var frame = '<iframe id="loleafletframe_viewer" name= "loleafletframe_viewer" style="width:100%;height:100%;position:absolute;"/>';

			$('#revViewer').append(form);
			$('#revViewer').append(frame);

			// submit that
			$('#loleafletform_viewer').submit();
			documentsMain.isViewerMode = true;

			// for closing revision mode
			$('#revViewerContainer .closeButton').click(function(e) {
				e.preventDefault();
				documentsMain.onCloseViewer();
			});
		},

		loadRevViewerContainer: function() {
			if(!$('revViewerContainer').length) {
				$(document.body).prepend(documentsMain.UI.viewContainer);
				var closeButton = $('<button class="icon-close closeButton" title="' + parent.t('richdocuments', 'Close version preview') + '"/>');
				$('#revViewerContainer').prepend(closeButton);
			}
		},

		showRevHistory: function(documentPath) {
			// TODO: make sure this also works if using the sidebar with the share icon and navigating to versions then
			parent.FileList.showDetailsView(documentsMain.fileName, 'versionsTabView');
			this.loadRevViewerContainer();
			// Load current revision
			// TODO: add entry to versions
			var fileId = documentsMain.fileId + '_' + 0;
			var title = documentsMain.fileName + ' - ' + 0;
			documentsMain.UI.showViewer(
				fileId, title
			);

			return;
		},

		addVersionSidebarEvents: function() {
			$(parent.document.querySelector('#content')).on('click.revisions', '#app-sidebar .preview-container', this.showVersionPreview.bind(this));
			$(parent.document.querySelector('#content')).on('click.revisions', '#app-sidebar .downloadVersion', this.showVersionPreview.bind(this));
			// Use mousedown event to overwrite behavior of the versions app
			$(parent.document.querySelector('#content')).on('mousedown.revisions', '#app-sidebar .revertVersion', this.restoreVersion.bind(this));
		},

		removeVersionSidebarEvents: function() {
			$(parent.document.querySelector('#content')).off('click.revisions');
			$(parent.document.querySelector('#content')).off('click.revisions');
			$(parent.document.querySelector('#content')).off('mousedown.revisions');
		},

		addCurrentVersion: function() {
			var preview = OC.MimeType.getIconUrl(parent.OCA.Files.App.fileList._currentFileModel.get('mimetype'));
			parent.$('#versionsTabView').prepend('<ul id="currentVersion"><li data-revision="0" class="active"><div><div class="preview-container"><img src="' + preview + '" width="44" /></div><div class="version-container">\n' +
				'<div><a class="downloadVersion">' + t('richdocuments', 'Current version') + '</a></div></div></li></ul>');
		},

		showVersionPreview: function (e) {
			e.preventDefault();
			documentsMain.UI.loadRevViewerContainer();
			var element = e.currentTarget.parentElement.parentElement;
			if ($(e.currentTarget).hasClass('downloadVersion')) {
				element = e.currentTarget.parentElement.parentElement.parentElement.parentElement;
			}
			var version = element.dataset.revision;
			var fileId = documentsMain.fileId + '_' + version;
			var title = documentsMain.fileName + ' - ' + version;
			documentsMain.UI.showViewer(
				fileId, title
			);

			// mark only current <li> as active
			$(element.parentElement.parentElement).find('li').removeClass('active');
			$(element).addClass('active');
		},

		restoreVersion: function(e) {
			var self = this;
			e.preventDefault();
			e.stopPropagation();

			documentsMain.onCloseViewer();

			documentsMain.WOPIPostMessage($('#loleafletframe')[0], 'Host_VersionRestore', {Status: 'Pre_Restore'});

			var version = e.currentTarget.parentElement.parentElement.dataset.revision;

			documentsMain.$deferredVersionRestoreAck = $.Deferred();
			jQuery.when(documentsMain.$deferredVersionRestoreAck).done(function(args) {
				var nextcloudVersion = parseInt(parent.oc_config.version.split('.')[0]);
				if (nextcloudVersion < 15) {
					self._restoreAjax(version);
				} else {
					self._restoreDAV(version)
				}
			});

			// resolve the deferred object immediately if client doesn't support version states
			if (!documentsMain.wopiClientFeatures || !documentsMain.wopiClientFeatures.VersionStates) {
				documentsMain.$deferredVersionRestoreAck.resolve();
			}

			return false;
		},

		_restoreSuccess: function(response) {
			if (response.status === 'error') {
				documentsMain.UI.notify(t('richdocuments', 'Failed to revert the document to older version'));
			}

			// load the file again, it should get reverted now
			window.location = $(parent.document.querySelector('#richdocumentsframe')).attr('src');
			documentsMain.overlay.documentOverlay('hide');
			parent.OC.Apps.hideAppSidebar();
		},

		_restoreError: function() {
			documentsMain.UI.notify(t('richdocuments', 'Failed to revert the document to older version'));
		},

		_restoreDAV: function(version) {
			var restoreUrl = OC.linkToRemoteBase('dav') + '/versions/' + parent.OC.getCurrentUser().uid
				+ '/versions/' + documentsMain.originalFileId + '/' + version;
			$.ajax({
				type: 'MOVE',
				url: restoreUrl,
				headers: {
					Destination: OC.linkToRemote('dav') + '/versions/' + parent.OC.getCurrentUser().uid + '/restore/target'
				},
				success: this._restoreSuccess,
				error: this._restoreError
			});
		},

		_restoreAjax: function(version) {
			var restoreUrl = OC.generateUrl('apps/files_versions/ajax/rollbackVersion.php?file={file}&revision={revision}',
					{
						file: documentsMain.fullPath, revision: version
					});
			$.ajax({
				type: 'GET',
				url: restoreUrl,
				success: this._restoreSuccess,
				error: this._restoreError
			});
		},

		showEditor : function(title, fileId, action){
			if (documentsMain.loadError) {
				documentsMain.onEditorShutdown(documentsMain.loadErrorMessage + '\n' + documentsMain.loadErrorHint);
				return;
			}

			if (!documentsMain.renderComplete) {
				setTimeout(function() { documentsMain.UI.showEditor(title, action); }, 500);
				console.log('Waiting for page to render…');
				return;
			}

			OC.Util.History.addOnPopStateHandler(_.bind(documentsMain.onClose));
			OC.Util.History.pushState();

			parent.postMessage('loading', '*');

			$(document.body).addClass("claro");
			$(document.body).prepend(documentsMain.UI.container);

			parent.document.title = title + ' - ' + documentsMain.UI.mainTitle;

			// WOPISrc - URL that loolwsd will access (ie. pointing to ownCloud)
			var wopiurl = window.location.protocol + '//' + window.location.host + OC.generateUrl('apps/richdocuments/wopi/files/{file_id}', {file_id: documentsMain.fileId});
			var wopisrc = encodeURIComponent(wopiurl);

			// urlsrc - the URL from discovery xml that we access for the particular
			// document; we add various parameters to that.
			// The discovery is available at
			//	 https://<loolwsd-server>:9980/hosting/discovery
			var urlsrc = documentsMain.urlsrc +
				"WOPISrc=" + wopisrc +
				"&title=" + encodeURIComponent(title) +
				"&lang=" + OC.getLocale().replace('_', '-') + // loleaflet expects a BCP47 language tag syntax
				"&closebutton=1" +
				"&revisionhistory=1";
			if (!documentsMain.canEdit || action === "view") {
				urlsrc += "&permission=readonly";
			}

			// access_token - must be passed via a form post
			var access_token = encodeURIComponent(documentsMain.token);

			// form to post the access token for WOPISrc
			var form = '<form id="loleafletform" name="loleafletform" target="loleafletframe" action="' + urlsrc + '" method="post">' +
				'<input name="access_token" value="' + access_token + '" type="hidden"/></form>';

			// iframe that contains the Collabora Online
			var frame = '<iframe id="loleafletframe" name="loleafletframe" scrolling="no" allowfullscreen style="width:100%;height:100%;position:absolute;" />';

			$('#mainContainer').append(form);
			$('#mainContainer').append(frame);

			// Listen for App_LoadingStatus as soon as possible
			$('#loleafletframe').ready(function() {
				var editorInitListener = function(e) {
					var msg = JSON.parse(e.data);
					if (msg.MessageId === 'App_LoadingStatus') {
						if (msg.Values.Status === "Frame_Ready" ) {
							documentsMain.wopiClientFeatures = msg.Values.Features;
							documentsMain.overlay.documentOverlay('hide');

							// Forward to mobile handler
							if (window.RichDocumentsMobileInterface) {
								window.RichDocumentsMobileInterface.documentLoaded();
							}

							// iOS webkit fallback
							if (window.webkit
								&& window.webkit.messageHandlers
								&& window.webkit.messageHandlers.RichDocumentsMobileInterface) {
								window.webkit.messageHandlers.RichDocumentsMobileInterface.postMessage('documentLoaded');
							}
						} else if (msg.Values.Status === "Document_Loaded" ) {
							window.removeEventListener('message', editorInitListener, false);
						}
					}
				};
				window.addEventListener('message', editorInitListener, false);
			});

			$('#loleafletframe').load(function(){
				// And start listening to incoming post messages
				window.addEventListener('message', function(e){
					if (documentsMain.isViewerMode) {
						return;
					}

					try {
						var msg = JSON.parse(e.data);
						var msgId = msg.MessageId;
						var args = msg.Values;
						var deprecated = !!args.Deprecated;
					} catch(exc) {
						msgId = e.data;
					}

					// Check for webview handler
					if (window.RichDocumentsMobileInterface) {
						if (msgId === 'UI_Close') {
							window.RichDocumentsMobileInterface.close();
						} else if (msgId === 'UI_InsertGraphic') {
							window.RichDocumentsMobileInterface.insertGraphic();
						} else if (msgId === 'UI_Share') {
							window.RichDocumentsMobileInterface.share();
						}
						return;
					}

					// iOS webkit fallback
					if (window.webkit
						&& window.webkit.messageHandlers
						&& window.webkit.messageHandlers.RichDocumentsMobileInterface) {
						if (msgId === 'UI_Close') {
							window.webkit.messageHandlers.RichDocumentsMobileInterface.postMessage('close');
						} else if (msgId === 'UI_InsertGraphic') {
							window.webkit.messageHandlers.RichDocumentsMobileInterface.postMessage('insertGraphic');
						} else if (msgId === 'UI_Share') {
							window.webkit.messageHandlers.RichDocumentsMobileInterface.postMessage('share');
						}
						return;
					}

					if (msgId === 'UI_Close' || msgId === 'close' /* deprecated */) {
						// If a postmesage API is deprecated, we must ignore it and wait for the standard postmessage
						// (or it might already have been fired)
						if (deprecated)
							return;

						documentsMain.onClose();
					} else if (msgId === 'UI_FileVersions' || msgId === 'rev-history' /* deprecated */) {
						if (deprecated)
							return;

						documentsMain.UI.showRevHistory(documentsMain.fullPath);
					} else if (msgId === 'UI_SaveAs') {
						// TODO it's not possible to enter the
						// filename into the OC.dialogs.filepicker; so
						// it will be necessary to use an own tree
						// view or something :-(
						//OC.dialogs.filepicker(t('richdocuments', 'Save As'),
						//      function(val) {
						//              console.log(val);
						//              documentsMain.WOPIPostMessage($('#loleafletframe')[0], Action_SaveAs', {'Filename': val});
						//      }, false, null, true);
						OC.dialogs.prompt(
							t('richdocuments', 'Please enter the filename to store the document as.'),
							t('richdocuments', 'Save As'),
							function(result, value) {
								if (result === true && value) {
									documentsMain.WOPIPostMessage($('#loleafletframe')[0], 'Action_SaveAs', {'Filename': value});
								}
							},
							true,
							t('richdocuments', 'New filename'),
							false
						).then(function() {
							var $dialog = $('.oc-dialog:visible');
							var $buttons = $dialog.find('button');
							$buttons.eq(0).text(t('richdocuments', 'Cancel'));
							$buttons.eq(1).text(t('richdocuments', 'Save'));
						});
					} else if (msgId === 'UI_InsertGraphic') {
						parent.OC.dialogs.filepicker(t('richdocuments', 'Insert Graphic'), function(path, type) {
							if (type === OC.dialogs.FILEPICKER_TYPE_CHOOSE) {
								var filename = path.substring(path.lastIndexOf('/') + 1);
								$.ajax({
									type: 'POST',
									url: OC.generateUrl('apps/richdocuments/assets'),
									data: {
										path: path
									}
								}).done(function(resp) {
									documentsMain.postAsset(filename, resp.url);
								});
							}
						}, false, ['image/png', 'image/gif', 'image/jpeg', 'image/svg'], true, OC.dialogs.FILEPICKER_TYPE_CHOOSE);
					} else if (msgId === 'App_VersionRestore') {
						if (!documentsMain.$deferredVersionRestoreAck) {
							console.warn('No version restore deferred object found.');
							return;
						}

						if (args.Status === 'Pre_Restore_Ack') {
							// user instructed to restore the version
							documentsMain.$deferredVersionRestoreAck.resolve();
						}
					} else if (msgId === 'View_Added') {
						documentsMain.UI.views[args.ViewId] = args;
						documentsMain.UI.renderAvatars();
					} else if (msgId === 'View_Removed') {
						delete documentsMain.UI.views[args.ViewId];
						documentsMain.UI.renderAvatars();
					} else if (msgId === 'Get_Views_Resp') {
						args.forEach(function(view) {
							documentsMain.UI.views[view.ViewId] = view;
						});
						documentsMain.UI.renderAvatars();
					}
				});

				// Tell the LOOL iframe that we are ready now
				documentsMain.WOPIPostMessage($('#loleafletframe')[0], 'Host_PostmessageReady', {});
			});

			// submit that
			$('#loleafletform').submit();
		},

		hideEditor : function(){
			// Fade out editor
			$('#mainContainer').fadeOut('fast', function() {
				$('#mainContainer').remove();
				$('#content-wrapper').fadeIn('fast');
				$(document.body).removeClass('claro');
				parent.document.title = documentsMain.UI.mainTitle;
			});
		},

		showProgress : function(message){
			if (!message){
				message = '&nbsp;';
			}
			$('.documentslist .progress div').text(message);
			$('.documentslist .progress').show();
		},

		hideProgress : function(){
			$('.documentslist .progress').hide();
		},

		notify : function(message){
			OC.Notification.show(message);
			setTimeout(OC.Notification.hide, 10000);
		}
	},

	onStartup: function() {
		var fileId;
		documentsMain.UI.init();

		// Does anything indicate that we need to autostart a session?
		fileId = getURLParameter('fileId').replace(/^\W*/, '');

		documentsMain.show(fileId);

		if (fileId && Number.isInteger(Number(fileId)) && $('#nickname').length === 0) {
			documentsMain.overlay.documentOverlay('show');
			documentsMain.prepareSession();
			documentsMain.originalFileId = fileId;
		}

		documentsMain.ready = true;
	},

	WOPIPostMessage: function(iframe, msgId, values) {
		if (iframe) {
			var msg = {
				'MessageId': msgId,
				'SendTime': Date.now(),
				'Values': values
			};

			iframe.contentWindow.postMessage(JSON.stringify(msg), '*');
		}
	},

	prepareSession : function(){
		documentsMain.isEditorMode = true;
		documentsMain.overlay.documentOverlay('show');
	},

	initSession: function() {
		documentsMain.urlsrc = richdocuments_urlsrc;
		documentsMain.fullPath = richdocuments_path;
		documentsMain.token = richdocuments_token;

		$('footer,nav').hide();
		$(documentsMain.toolbar).appendTo('#header');

		documentsMain.canShare = typeof OC.Share !== 'undefined' && richdocuments_permissions & OC.PERMISSION_SHARE;

		// fade out file list and show the document
		$('#content-wrapper').fadeOut('fast').promise().done(function() {

			documentsMain.fileId = richdocuments_fileId;
			documentsMain.fileName = richdocuments_title;

			documentsMain.canEdit = Boolean(richdocuments_permissions & OC.PERMISSION_UPDATE);

			documentsMain.loadDocument(documentsMain.fileName, documentsMain.fileId);
		});
	},

	view : function(id){
		OC.addScript('richdocuments', 'viewer/viewer', function() {
			$(window).off('beforeunload');
			$(window).off('unload');
			var path = $('li[data-id='+ id +']>a').attr('href');
			odfViewer.isDocuments = true;
			odfViewer.onView(path);
		});
	},

	loadDocument: function(title, fileId) {
		documentsMain.UI.showEditor(title, fileId, 'write');
	},

	onEditorShutdown : function (message){
			OC.Notification.show(message);

			$(window).off('beforeunload');
			$(window).off('unload');
			if (documentsMain.isEditorMode){
				documentsMain.isEditorMode = false;
				parent.location.hash = "";
			} else {
				setTimeout(OC.Notification.hide, 7000);
			}
			documentsMain.UI.hideEditor();

			documentsMain.show();
			$('footer,nav').show();
	},

	onClose: function() {
		documentsMain.isEditorMode = false;
		$(window).off('beforeunload');
		$(window).off('unload');
		parent.location.hash = "";

		$('footer,nav').show();
		documentsMain.UI.hideEditor();
		$('#ocToolbar').remove();

		parent.document.title = documentsMain.UI.mainTitle;
		parent.postMessage('close', '*');
		this.UI.removeVersionSidebarEvents();
	},

	onCloseViewer: function() {
		$('#revisionsContainer *').off();

		$('#revPanelContainer').remove();
		$('#revViewerContainer').remove();
		documentsMain.isViewerMode = false;
		documentsMain.UI.revisionsStart = 0;
		parent.$('#versionsTabView .active').removeClass('active');
		parent.$('#versionsTabView #currentVersion').remove();
		$('#loleafletframe').focus();
	},

	show: function(fileId){
		documentsMain.UI.showProgress(t('richdocuments', 'Loading documents…'));
		documentsMain.docs.documentGrid('render', fileId);
		documentsMain.UI.hideProgress();
	},

	postAsset: function(filename, url) {
		documentsMain.WOPIPostMessage($('#loleafletframe')[0], 'Action_InsertGraphic', {
			filename: filename,
			url: url
		});
	},
};

$(document).ready(function() {

	if (!OCA.Files) {
		OCA.Files = {};
		OCA.Files.App = {};
		OCA.Files.App.fileList = FileList;
	}

	if (!OC.Share) {
		OC.Share = {};
	}

	window.Files = FileList;

	OCA.RichDocuments.documentsMain = documentsMain;

	documentsMain.docs = $('.documentslist').documentGrid();
	documentsMain.overlay = $('<div id="documents-overlay" class="icon-loading"></div><div id="documents-overlay-below" class="icon-loading-dark"></div>').documentOverlay();

	$('li.document a').tipsy({fade: true, live: true});


	documentsMain.onStartup();
});

(function() {
	if (!OCA.RichDocuments) {
		OCA.RichDocuments = {};
	}
})();
