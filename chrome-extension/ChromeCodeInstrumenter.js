import fromJSCss from "../src/fromjs.css"
import beautify from "js-beautify"
import processJavaScriptCode from "../src/compilation/processJavaScriptCode"
import _ from "underscore"
import startsWith from "starts-with"

const FromJSSessionStages = {
    RELOADING: "RELOADING",
    INITIALIZING: "INITIALIZING",
    INITIALIZED: "INITIALIZED",
    ACTIVATING: "ACTIVATING",
    ACTIVE: "ACTIVE",
    CLOSED: "CLOSED"
}

var resolveFrameWorkerCode = "not loaded yet"
var inhibitJSExecutionCode = "not loaded yet"
var injectedJSCode = "not loaded yet"
/* PRE_EMBED_SCRIPTS_HERE_INSTEAD_OF_FETCH */

var hasEmbedded = resolveFrameWorkerCode !== "not loaded yet"

if (!hasEmbedded) {
    fetch(chrome.extension.getURL("resolveFrameWorker.js"))
    .then(function(r){
        return r.text()
    })
    .then(function(text){
        resolveFrameWorkerCode = text
    })

    // Needs to be injected as text as otherewise execution is delayed by a tiny bit,
    // which means page JS is executed beforehand.
    // looks like a chrome bug: https://bugs.chromium.org/p/chromium/issues/detail?id=634381#c11
    fetch(chrome.extension.getURL("inhibitJavaScriptExecution.js"))
    .then(function(r){
        return r.text()
    })
    .then(function(text){
        inhibitJSExecutionCode = text
    })

    fetch(chrome.extension.getURL("injected.js"))
    .then(function(r){
        return r.text()
    })
    .then(function(text){
        injectedJSCode = text
    })
}

class ChromeCodeInstrumenter {
    constructor(options){
        var defaultOptions = {
            showTabStatusBadge: true
        }
        options = _.extend({}, options, defaultOptions)
        this.options = options;
        this.sessionsByTabId = {};

        var self = this;

        if (options.showTabStatusBadge){
            chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
                this.updateBadge(tabId)
            })
        }

        // I moved this outside the main handler since it didn't seem to pick it up anymore... maybe because it's in an iframe
        chrome.webRequest.onBeforeRequest.addListener(function(info){
            console.log("general onbeforerequst", info.url)
            
            if (self.getTabSession(info.tabId)) {
                if (info.url.indexOf("/fromjs-internals/") !== -1) {
                    var parts = info.url.split("/fromjs-internals/")
                    var fileName = parts[1]
                    console.log("redirecting to ", chrome.extension.getURL(fileName))
                    return {
                        redirectUrl: chrome.extension.getURL(fileName)
                    }
                }
            }
        }, {urls: ["<all_urls>"]}, ["blocking"]);

        chrome.tabs.onUpdated.addListener(function(tabId, changeInfo, tab){
            var session = self.getTabSession(tabId);

            if (!session || session.isActive()){
                return
            }

            console.log("changeInfo", changeInfo)
            if (changeInfo.status === "complete") {
                session.activate()
            }
            if (changeInfo.status === "loading") {
                // Need to check if stage is RELOADING, because the
                // tab state provided by changeInfo can revert
                // back to loading after the session has already been
                // initialized
                if (session.isReloading()) {
                    session.initialize();
                } else {
                    console.log("changeinfo status is back to loading, but session is already initialized (stage:", session._stage, ")")
                }
            }
        })

        chrome.tabs.onRemoved.addListener(function(tabId){
            var session = self.getTabSession(tabId);
            console.log("onremoved")
            if (session){
                console.log("closing")
                session.close();
            }
        })

        chrome.runtime.onMessage.addListener(function(request, sender) {
            console.log("Got message", request)
            if (!request.isFromJSExtensionMessage) {return}

            var session = self.getTabSession(sender.tab.id)
            if (!session){
                console.error("Got message for tab without session", request)
                return
            }

            var usedMessageHandlers = _.extend({}, self.options.additionalMessageHandlers, messageHandlers)

            var handler = usedMessageHandlers[request.type];
            if (handler) {
                handler(session, request, function(){
                    session.executeScriptOnPage(request.callbackName + "(decodeURI(`" + encodeURI(JSON.stringify(Array.from(arguments))) + "`))");
                })
            } else {
                throw "no handler for message type " + request.type
            }
        });
    }
    getTabSession(tabId){
        return this.sessionsByTabId[tabId]
    }
    toggleTabInstrumentation(tabId, options){
        var session = this.getTabSession(tabId);
        if (session){
            session.close();
            chrome.tabs.reload(tabId)
        } else {
            this.createSession(tabId, options)
        }
    }
    reloadTabWithInstrumentationEnabled(tabId, options){
        var session = this.getTabSession(tabId);
        if (session){
            session.close();
        }
        this.createSession(tabId, options)
    }
    createSession(tabId, options = {}){
        if (this.getTabSession(tabId)) {
            debugger;
            console.error("Tab already has session")
        }
        options = Object.assign({}, this.options, options)
        var session = new BabelSession(tabId,
            {
                ...options,
                onClosedCallbackForInstrumenterClass: (session) => {
                    delete this.sessionsByTabId[session.tabId]
                    this.updateBadge(session.tabId)
                }
            })
        this.sessionsByTabId[tabId] = session;

        if (this.options.showTabStatusBadge){
            this.updateBadge(tabId)
        }
    }
    updateBadge(tabId){
        var text = ""
        var session = this.getTabSession(tabId)
        if (session) {
            text = "ON"
        }
        chrome.browserAction.setBadgeText({
            text: text,
            tabId: tabId
        });
        chrome.browserAction.setBadgeBackgroundColor({
            tabId: tabId,
            color: "#cc5214"
        })
    }
}

class BabelSession {
    constructor(tabId, options){
        this.tabId = tabId;
        this._stage = FromJSSessionStages.RELOADING;
        this._pageHtml = null;
        this._downloadCache = {}
        this._processJSCodeCache = {};
        this._loadedScriptURLs = [];
        this._babelPlugin = options.babelPlugin
        this._logBGPageLogsOnInspectedPage = options.logBGPageLogsOnInspectedPage
        this._onBeforePageLoad = options.onBeforePageLoad
        this._onInstrumentationError = options.onInstrumentationError
        this.onClosedCallbackForInstrumenterClass = options.onClosedCallbackForInstrumenterClass
        this._jsExecutionInhibitedMessage = options.jsExecutionInhibitedMessage
        this._loadingMessagePrefix = options.loadingMessagePrefix
        this._beautifyCode = options.beautifyCode

        chrome.tabs.get(tabId, (tab) => {
            if (!tab.url || startsWith(tab.url, "chrome://")) {
                if (options.onCantInstrumentThisPage){
                    options.onCantInstrumentThisPage();
                } else {
                    alert("Can't instrument code for this URL")
                }

                return;
            }
            _.defer(() => this._open())
        });
    }
    _open(){
        this._log("Open tab", this.tabId)
        this._onBeforeRequest = makeOnBeforeRequest(this)
        this._onHeadersReceived = makeOnHeadersReceived();

        chrome.webRequest.onBeforeRequest.addListener(this._onBeforeRequest, {urls: ["<all_urls>"], tabId: this.tabId}, ["blocking"]);
        chrome.webRequest.onHeadersReceived.addListener(this._onHeadersReceived, {urls: ["<all_urls>"], tabId: this.tabId}, ["blocking", "responseHeaders"])

        chrome.tabs.reload(this.tabId)
    }
    initialize(){
        this._log("Init tab", this.tabId)
        var self = this;
        this._stage = FromJSSessionStages.INITIALIZING;

        var jsExecutionInhibitedMessage = ''
        if (this._jsExecutionInhibitedMessage) {
            jsExecutionInhibitedMessage = this._jsExecutionInhibitedMessage
        }

        this._executeScript({
            code: `
                var el = document.createElement("script")
                el.textContent = decodeURI("${encodeURI(inhibitJSExecutionCode)}")
                document.documentElement.appendChild(el)

                el = document.createElement("script")
                el.textContent = "window.allowJSExecution = inhibitJavaScriptExecution(decodeURI('${encodeURI(jsExecutionInhibitedMessage)}'))"
                document.documentElement.appendChild(el)
            `,
            runAt: "document_start"
        }, function(){
            self._log("INITIALIZED")
            self._stage = FromJSSessionStages.INITIALIZED
        });

        chrome.tabs.insertCSS(this.tabId, {
            code: `
                body {opacity: 0}
                html.fromJSRunning body {opacity: 1}
            `,
            runAt: "document_start"
        });
        this._executeScript({
            code: "document.body.innerHTML = 'Loading...';document.body.parentElement.classList.add('fromJSRunning')",
            runAt: "document_idle"
        });
    }
    activate(){
        if (this._stage !== FromJSSessionStages.INITIALIZED) {
            this._log("Delay activation until stage is INITIALIZED, current stage: ", this._stage)
            setTimeout(() => this.activate(), 100)
            return;
        }
        this._log("Activate tab", this.tabId)
        this._stage = FromJSSessionStages.ACTIVATING;

        chrome.tabs.insertCSS(this.tabId, {
            code: fromJSCss[0][1]
        })

        var self = this;

        self._executeScript({
            code: `
            var script = document.createElement("script")
            script.text = "window.allowJSExecution();"
            document.documentElement.appendChild(script)
            `,
        }, function(){
            self._log("re-enabled js execution")
            self._executeScript({
                code: `
                    var script = document.createElement("script")
                    script.text = \`
                        window.fromJSResolveFrameWorkerCode = decodeURI(\\"${encodeURI(resolveFrameWorkerCode)}\\");
                        window.createCodePreprocessor = function(CodePreprocessor){

                            window.codePreprocessor = new CodePreprocessor({
                                babelPlugin: eval(decodeURI("(${encodeURI(self._babelPlugin.toString())})"))
                            })
                            console.log("assigned", window.codePreprocessor)
                        }
                    \`

                    document.documentElement.appendChild(script)
                `
            }, function(){

                self._executeScript({
                    code: `
                        console.log("going to load injected.js")

                        var el = document.createElement("script")
                        el.text = decodeURI("${encodeURI(injectedJSCode)}")
                        el.setAttribute("charset", "utf-8")
                        document.documentElement.appendChild(el)

                        if (window.fromJSRebroadcastListenerAdded) {
                            // not sure exactly why this happens, but sometimes this code runs twice...
                            alert("Error: already loaded")
                        }
                        window.fromJSRebroadcastListenerAdded = true;
                        window.addEventListener("RebroadcastExtensionMessage", function(evt) {
                            if (!evt.detail || !evt.detail.isFromJSExtensionMessage) {
                                return
                            }
                            chrome.runtime.sendMessage(evt.detail);
                        }, false);
                    `
                }, function(){
                    self._log("added injectedjs")
                    var encodedPageHtml = encodeURI(self._pageHtml)
                    self._executeScript({
                        code: `
                            var script = document.createElement("script");

                            script.innerHTML += "window.pageHtml = decodeURI(\\"${encodedPageHtml}\\");";
                            document.documentElement.appendChild(script)
                          `
                    }, function(){
                        console.log("waiting for injected.js to be injected")

                        if (self._onBeforePageLoad){
                            self._onBeforePageLoad(function(){
                                cont()
                            })
                        } else {
                            cont();
                        }
                        function cont(){
                            console.log("about to start loading")
                            self._stage = FromJSSessionStages.ACTIVE;
                            self.executeScriptOnPage(`
                                if (document.readyState === "complete") {
                                    setTimeout(startLoading, 0)
                                } else {
                                    document.addEventListener("readystatechange", function(){
                                        if (document.readyState === "complete") {
                                            startLoading()
                                        }
                                    })
                                }
                                function startLoading(){
                                    if (!window.startLoadingPage) {
                                        setTimeout(startLoading, 100)
                                        return;
                                    }
                                    window.startLoadingPage(decodeURI("${encodeURI(self._loadingMessagePrefix)}"))
                                }
                            `)
                        }
                    })
                })
            })
        })
    }
    _log(){
        console.log.apply(console, arguments);
        if (!this.isClosed() && this._logBGPageLogsOnInspectedPage) {
            this._executeScript("console.log('Background page log: " + JSON.stringify(arguments) + "')")
        }
    }
    _executeScript(codeOrParamObject, callback){
        if (this.isClosed()) {
            this._log("Not executing code for closed session")
            return;
        }
        var obj;
        if (typeof codeOrParamObject === "string"){
            obj = {
                code: codeOrParamObject
            }
        } else {
            obj = codeOrParamObject
        }
        chrome.tabs.executeScript(this.tabId, obj, callback)
    }
    executeScriptOnPage(code, callback){
        var encodedCode = encodeURI(code);
        this._executeScript({
            code: `
                var script = document.createElement("script");
                script.text = decodeURI("${encodedCode}");
                document.documentElement.appendChild(script)
                script.remove();
            `
        }, callback);
    }

    _getJavaScriptFile(url){
        var self = this;
        return new Promise(function(resolve, reject){
            if (self._downloadCache[url]) {
                resolve(self._downloadCache[url])
            } else {
                fetch(url)
                .then((r) => r.text())
                .then((code) => {
                    if (self._beautifyCode){
                        // Ideally this would happen when displaying the code in the UI,
                        // rather than when it's downloaded (doing it now means the line
                        // numbers will be incorrect)
                        // But for now it's too much work to do it later, would need
                        // to apply source maps...
                        code = beautifyJS(code)
                    }

                    self._downloadCache[url] = code
                    resolve(code)
                })
            }

        })
    }
    _processJavaScriptCode(code, options){
        var key = code + JSON.stringify(options);
        if (!this._processJSCodeCache[key]) {
            try {
                var res = processJavaScriptCode(this._babelPlugin)(code, options);
            } catch (err) {
                if (this._onInstrumentationError) {
                    this._onInstrumentationError(err, options, this);
                }
                throw err
            }

            this._processJSCodeCache[key] = {
                map: res.map,
                code: res.code
            };
        }
        return this._processJSCodeCache[key]
    }
    getCode(url, processCode){
        var self = this;
        var promise = new Promise(function(resolve, reject){
            self._getJavaScriptFile(url).then(function(code){
                if (processCode) {
                    var res = self._processJavaScriptCode(code, {filename: url})
                    code = res.code
                    code += "\n//# sourceURL=" + url
                    code += "\n//# sourceMappingURL=" + url + ".map"
                }

                resolve(code)
            })
        })

        return promise;
    }
    getProcessedCode(url){
        return this.getCode(url, true)
    }
    getSourceMap(url){
        url = url.slice(0, -".map".length)
        return new Promise((resolve) => {
            this._getJavaScriptFile(url).then((code) => {
                var sourceMap = this._processJavaScriptCode(code, {filename: url}).map
                resolve(sourceMap)
            })
        })
    }
    loadScript(requestUrl, callback){
        if (this._loadedScriptURLs.indexOf(requestUrl) !== -1) {
            // On StackOverflow.com the full.en.js script was loaded twice, once through a
            // script tag in the initial HTML and once through an injected script tag
            // That might just be because we both inject the script in the DOM and try to fetch it???
            console.warn("Canceling attempt to load same script URL twice, probably not intended", requestUrl)
            return
        }

        this._log("Fetching and processing", requestUrl)
        this._loadedScriptURLs.push(requestUrl)

        var self =this;
        this.getProcessedCode(requestUrl)
        .then(function(code){
            self._log("Injecting", requestUrl)
            self.executeScriptOnPage(code, function(){
                if (callback){
                    callback()
                }
            })
        })
    }
    isActive(){
        return this._stage === FromJSSessionStages.ACTIVE;
    }
    isReloading(){
        return this._stage === FromJSSessionStages.RELOADING;
    }
    close(){
        chrome.webRequest.onBeforeRequest.removeListener(this._onBeforeRequest)
        chrome.webRequest.onHeadersReceived.removeListener(this._onHeadersReceived)

        this._stage = FromJSSessionStages.CLOSED;
        this.onClosedCallbackForInstrumenterClass(this)
    }
    isClosed(){
        return this._stage === FromJSSessionStages.CLOSED
    }
    setPageHtml(pageHtml) {
        this._pageHtml = pageHtml;
    }
    getPageHtml(){
        return this._pageHtml;
    }
    pageHasBeenLoaded(){
        return this._pageHtml !== null;
    }
}

/*
We're modifying the headers because some websites (e.g. twitter) otherwise prevent us
from creating a webworker from a blob origin.
Instead of modifying the headers we could instead move the resolveFrame web worker
into the bg page.
*/
function makeOnHeadersReceived(){
     return function onHeadersReceived(details){
         if (details.type !== "main_frame") {return}

         for (var i=0; i<details.responseHeaders.length; i++) {
             if (details.responseHeaders[i].name.toLowerCase() === "content-security-policy" ) {
                 details.responseHeaders[i].value = ""
             }
         }

         return {
             responseHeaders: details.responseHeaders
         }
     }
 }


function makeOnBeforeRequest(session){
    // make unique function so we can call removeListener later
    function onBeforeRequest(info){
        console.log("request for url", info.url, info)
        if (session.isClosed()){
            return;
        }

        // We don't want to send any errors or tracked objects or similar to
        // analytics services.
        // However, this could in theory break some code too.
        if (info.url.indexOf("segment.io") !== -1 ||
            info.url.indexOf("googleadservices") !== -1 ||
            info.url.indexOf("google-analytics") !== -1 ||
            info.url.indexOf("googletagmanager") !== -1 ||
            info.url.indexOf("mixpanel") !== -1 ||
            info.url.indexOf("newrelic") !== -1 ||
            info.url.indexOf("bugsnag") !== -1){
            return {cancel: true}
        }

        if (info.url.indexOf("/fromjs-internals/") !== -1) {
            return // handled by global handler
        }

        if (info.url.slice(0, "chrome-extension://".length) === "chrome-extension://") {
            return
        }

        if (info.type === "main_frame") {
            if (session.pageHasBeenLoaded()){
                session.close();
                return;
            }

            var xhr = new XMLHttpRequest()
            xhr.open('GET', info.url, false);
            xhr.send(null);
            session.setPageHtml(xhr.responseText)

            var parts = info.url.split("/");parts.pop(); parts.push("");
            var basePath = parts.join("/")
            return
        }

        if (urlLooksLikeJSFile(info.url) && info.type === "script") {
            if (session.isActive()) {
                session.loadScript(info.url)
            }
            return {cancel: true}
        }
    }
    return onBeforeRequest
}






function urlLooksLikeJSFile(url){
    var urlWithoutQueryParameters = url.split("?")[0]
    if (endsWith(urlWithoutQueryParameters, ".dontprocess")) {
        urlWithoutQueryParameters = urlWithoutQueryParameters.substr(0, - ".dontprocess".length)
    }
    return endsWith(urlWithoutQueryParameters, ".js")
}

function urlLooksLikeHtmlFile(url){
    var urlWithoutQueryParameters = url.split("?")[0]
    return endsWith(urlWithoutQueryParameters, ".html")
}



function beautifyJS(code){
    return beautify.js_beautify(code, {indent_size: 2})
}

function endsWith(str, strEnd){
  return str.slice(str.length - strEnd.length) === strEnd
}



var messageHandlers = {
    loadScript: function(session, request, callback){
        session.loadScript(request.url, callback)
    },
    // Use fetchUrl instead of a normal request in order to be able to
    // return processed code > 2MB (normally we redirect to a data URL,
    // which can't be > 2MB)
    fetchUrl: function(session, req, callback){
        var url = req.url

        var dontProcess = endsWith(url, ".dontprocess")
        if (dontProcess) {
            // debugger;
            url = url.slice(0, -".dontprocess".length)
        }
        if (url.slice(url.length - ".js.map".length) === ".js.map") {
            session.getSourceMap(url).then(function(sourceMap){
                callback(JSON.stringify(sourceMap))
            })
        } else if (urlLooksLikeJSFile(url)) {
            session.getCode(url, !dontProcess).then(function(code){
                callback(code)
            })
        } else if (urlLooksLikeHtmlFile(url)){
            var html = session.getPageHtml();
            callback(html)
        } else {
            console.error("No handler to fetch file", url)
            callback(null)
        }
    }
}

export default ChromeCodeInstrumenter

window.ChromeCodeInstrumenter = ChromeCodeInstrumenter
