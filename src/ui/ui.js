import React from "react"
import _ from "underscore"
import fileIsDynamicCode from "../fileIsDynamicCode"
import isMobile from "../isMobile"
import config from "../config"
import ReactTooltip from "react-tooltip"
import "react-fastclick" // import for side effects, no export
import adjustColumnForEscapeSequences from "../adjustColumnForEscapeSequences"
import getDefaultInspectedCharacterIndex from "./getDefaultInspectedCharacterIndex"
import RoundTripMessageWrapper from "../RoundTripMessageWrapper"

import Perf from "react-addons-perf"
window.Perf = Perf

var currentInspectedPage;

var resolvedFrameCache = {}
function resolveFrame(frameString, callback) {
    if (frameString === undefined) debugger

    if (resolvedFrameCache[frameString]) {
        callback(null, resolvedFrameCache[frameString])
        return function cancel(){}
    } else {
        return currentInspectedPage.send("resolveFrame", frameString, function(err, frame){
            if (!err){
                resolvedFrameCache[frameString] = frame;
            }
            callback(err, frame)
        });
    }
}

var codeFilePathCache = {}
function getCodeFilePath(path, callback) {
    if (codeFilePathCache[path]) {
        callback(codeFilePathCache[path])
        return function(){};
    } else {
        return currentInspectedPage.send("getCodeFilePath", path, function(newPath){
            codeFilePathCache[path] = newPath
            callback(newPath)
        })
    }
}


function getFilenameFromPath(path){
    var pathParts = path.split("/");
    var filename = _.last(pathParts);
    filename = filename.replace(".dontprocess", "");
    return filename
}

function catchExceptions(fnToRun, onError){
    if (config.catchUIErrors) {
        try {
            fnToRun()
        } catch (err) {
            onError(err)
        }
    } else {
        fnToRun();
    }
}

function truncate(str, maxLength){
    if (str.length <= maxLength) {
        return str
    }
    return str.substr(0, 40) + "..."
}


export class OriginPath extends React.Component {
    constructor(props){
        super(props)
        this.state = {
            showFullPath: false
        }
    }
    render(){
        var originPath = this.props.originPath;
        if (!originPath) {
            return <div>Fetching origin path</div>
        }
        originPath = originPath.filter(function(pathItem){
            // This is really an implementation detail and doesn't add any value to the user
            // Ideally I'd clean up the code to not generate that action at all,
            // but for now just filtering it out
            if (pathItem.origin.action === "Initial Body HTML") {
                return false;
            }
            return true;
        })
        window.originPath = originPath


        var lastOriginPathStep = _.last(originPath)
        var firstOriginPathStep = _.first(originPath)

        var inbetweenSteps = originPath.slice(1, originPath.length - 1).reverse();
        var inbetweenStepsComponents = []
        if (this.state.showFullPath){
            for (var originPathStep of inbetweenSteps) {
                inbetweenStepsComponents.push(this.getOriginPathItem(originPathStep))
            }
        }

        var lastStep = this.getOriginPathItem(lastOriginPathStep);
        var firstStep = null;
        if (originPath.length > 1) {
            firstStep = this.getOriginPathItem(firstOriginPathStep)
        }

        var showFullPathButton = null;
        if (!this.state.showFullPath && originPath.length > 2){
            showFullPathButton = <div style={{marginBottom: 20}}>
                <button
                    className="fromjs-btn-link"
                    ref="showFullPathButton"
                    onClick={() => {
                        this.refs.showFullPathButton.textContent = "Rendering additional steps may take a few seconds."
                        setTimeout(() => {
                            this.setState({showFullPath: true})
                        }, 10)
                    }}>
                    =&gt; Show {inbetweenSteps.length} steps in-between
                </button>
            </div>
        }

        return <div>
            {lastStep}
            {showFullPathButton}

            {inbetweenStepsComponents}

            {firstStep}
        </div>
    }
    getOriginPathItem(originPathStep){
        return <OriginPathItem
            key={JSON.stringify({
                originId: originPathStep.origin.id,
                characterIndex: originPathStep.characterIndex
            })}
            originPathItem={originPathStep}
            handleValueSpanClick={this.props.handleValueSpanClick}
        />
    }
}

class OriginPathItem extends React.Component {
    constructor(props){
        super(props)
        this.state = {
            selectedFrameIndex: 0,
            resolvedFrame: null,
            codeFilePath: null,
            previewFrameIndex: null
        }
    }
    componentDidMount(){
        this.makeSureIsResolvingFrame();
    }
    componentDidUpdate(){
        this.makeSureIsResolvingFrame();
    }
    makeSureIsResolvingFrame(){
        if (!this.state.resolvedFrame){
            this.cancelInProgessRequests()
            var origin = this.props.originPathItem.origin;
            this.cancelFrameResolution = resolveFrame(this.getSelectedFrameString(), (err, resolvedFrame) => {
                this.setState({resolvedFrame})

                this.cancelGetCodeFilePath = getCodeFilePath(resolvedFrame.fileName, (codeFilePath) => {
                    this.setState({codeFilePath})
                })
            })
        }
    }
    componentWillUnmount(){
        this.cancelInProgessRequests();
    }
    cancelInProgessRequests(){
        if (this.cancelGetCodeFilePath){
            this.cancelGetCodeFilePath()
        }
        if (this.cancelFrameResolution) {
            this.cancelFrameResolution()
        }
    }
    getSelectedFrameString(){
        return this.getFrameStringAtIndex(this.state.selectedFrameIndex)
    }
    getPreviewFrameString(){
        return this.getFrameStringAtIndex(this.state.previewFrameIndex)
    }
    getFrameStringAtIndex(index){
        var origin = this.props.originPathItem.origin
        if (index === null) {
            return null
        }
        if (origin.isHTMLFileContent) {
            return getFrameFromHTMLFileContentOriginPathItem(this.props.originPathItem)
        }
        return origin.stack[index]
    }
    render(){
        var originObject = this.props.originPathItem.origin

        // This isn't a crucial feature... you can just click on the origin inside the path
        // I disabled this feature because the fromJSDynamicFileOrigins is not available in the
        // inspector iframe,
        // var viewSourceOriginButton = null;
        // if (this.state.resolvedFrame && fileIsDynamicCode(this.state.resolvedFrame.fileName)){
        //     viewSourceOriginButton = <button
        //         className="fromjs-btn-link fromjs-origin-path-step__only-show-on-step-hover"
        //         onClick={
        //             () => this.props.handleValueSpanClick(fromJSDynamicFileOrigins[this.state.resolvedFrame.fileName], 0)
        //         }>
        //         Show Source Origin
        //     </button>
        // }

        var stack = null;
        var originPathItem = this.props.originPathItem;
        var previewStack = null;
        if (this.getPreviewFrameString()){
            previewStack = <StackFrame
                frameIndex={this.state.previewFrameIndex}
                frame={this.getPreviewFrameString()}
                key={this.getPreviewFrameString()}
                originPathItem={originPathItem} />
        }
        else if (this.getSelectedFrameString()) {
            stack = <StackFrame
                frameIndex={this.state.selectedFrameIndex}
                frame={this.getSelectedFrameString()}
                key={this.getSelectedFrameString()}
                originPathItem={originPathItem}
            />
        } else {
            stack = <div style={{padding: 10}}>
                (Empty stack.)
            </div>
        }


        var valueView = null;
        if (!config.alwaysShowValue && originObject.action === "Initial Page HTML") {
            valueView = <div></div>
        } else {
            valueView = <div style={{borderTop: "1px dotted #ddd"}} data-test-marker-step-value>
                <ValueEl
                    originPathItem={this.props.originPathItem}
                    handleValueSpanClick={this.props.handleValueSpanClick} />
            </div>
        }

        return <div className="fromjs-origin-path-step" style={{border: "1px solid #ddd", marginBottom: 20}}>
            <div >
                <OriginPathItemHeader
                    handleValueSpanClick={this.props.handleValueSpanClick}
                    originObject={originObject}
                    selectedFrameIndex={this.state.selectedFrameIndex}
                    resolvedFrame={this.state.resolvedFrame}
                    onFrameIndexHovered={(frameIndex) => this.setState({previewFrameIndex: frameIndex})}
                    onFrameIndexSelected={(frameIndex) => this.selectFrameIndex(frameIndex)}
                    codeFilePath={this.state.codeFilePath}
                    />

                {stack}
                {previewStack}
            </div>

                {valueView}

        </div>
    }
    selectFrameIndex(frameIndex){
        this.setState({
            selectedFrameIndex: frameIndex,
            resolvedFrame: null,
            codeFilePath: null
        })
    }
}

class OriginPathItemHeader extends React.Component {
    constructor(props){
        super(props)
        this.state = {
            showDetailsDropdown: false,
        }
    }
    render(){
        var originObject = this.props.originObject

        var filename = null
        if (this.props.resolvedFrame) {
            var uiFileName = this.props.resolvedFrame.uiFileName;

            filename = <span className="origin-path-step__filename">
                {uiFileName}
            </span>
        }

        var detailsDropdown = null;
        if (this.state.showDetailsDropdown){
            var noParametersMessage = null;
            if (originObject.inputValues.length === 0){
                noParametersMessage = <div style={{color: "#777"}}>(No parameters.)</div>
            }
            var inputValueLinks = <div style={{paddingBottom: 5}}>
                <div>
                    <span data-multiline data-tip={
                        "These are the input values of the string transformation.<br>"
                        + "The parameters of a string concatenation would be the two strings being joined together.<br>"
                        + "A replace call would show the original string, the string being replaced, and the replacement string."
                        }>
                        Parameters
                        <span className="fromjs-info-icon">i</span>:
                    </span>
                </div>
                {noParametersMessage}
                {originObject.inputValues.map((iv,i) => {
                    return <div
                        key={"inputValue" + i}
                        className="fromjs-input-value-link"
                        onClick={() => this.props.handleValueSpanClick(iv, 0)}>
                        &quot;{truncate(iv.value, 40)}&quot;
                    </div>
                })}
            </div>


            var stackFrameSelector = null;
            if (this.state.showDetailsDropdown){
                stackFrameSelector = <StackFrameSelector
                    stack={originObject.stack}
                    selectedFrameIndex={this.props.selectedFrameIndex}
                    onFrameSelected={(frameIndex) => {
                        this.props.onFrameIndexSelected(frameIndex)
                        this.setState({showDetailsDropdown: false})
                    }}
                    onFrameHovered={(frameIndex) => {
                        this.props.onFrameIndexHovered(frameIndex)
                    }}
                />
            }


            var codeLink = null;
            if (this.props.resolvedFrame && this.props.codeFilePath){
                codeLink = <a href={this.props.codeFilePath} target="_blank" style={{color: "#08f"}}>
                    Open {this.props.resolvedFrame.uiFileName} in new window
                </a>
            }


            detailsDropdown = <div>
                <div style={{background: "aliceblue", paddingLeft: 10, paddingBottom: 10}}>
                    {inputValueLinks}
                    {codeLink}
                </div>
                {stackFrameSelector}
            </div>
        }

        var toggleFrameSelectorButton = null;
        var callStackDeeperThanOneLevel = originObject.stack && originObject.stack.length > 1
        var hasInputValues = originObject.inputValues.length > 0
        if (callStackDeeperThanOneLevel || hasInputValues) {
            toggleFrameSelectorButton = <button
                className="fromjs-origin-path-step__stack-frame-selector-toggle"
                onClick={() => this.setState({showDetailsDropdown: !this.state.showDetailsDropdown})}>
                {this.state.showDetailsDropdown ? "\u25B2" : "\u25BC"}
            </button>
        }



        var callStackPath = <CallStackPath
            stack={originObject.stack}
            selectedIndex={this.props.selectedFrameIndex}
            onFrameIndexSelected={(frameIndex) => this.props.onFrameIndexSelected(frameIndex)}
            onFrameIndexHovered={(frameIndex) => this.props.onFrameIndexHovered(frameIndex)}
            key={originObject.id}/>

        return <div>
            <div style={{background: "aliceblue"}}>
                <div>
                    <span style={{
                        display: "inline-block",
                        padding: 5
                     }}>
                        <span style={{fontWeight: "bold", marginRight: 5}}
                            data-test-marker-step-action>
                            {this.props.originObject.action}
                        </span>
                        &nbsp;
                        <span>
                            {filename}
                            {callStackPath}
                        </span>
                    </span>
                    {toggleFrameSelectorButton}
                </div>
            </div>

            {detailsDropdown}



        </div>
    }
}

class CallStackPath extends React.Component {
    constructor(props){
        super(props)
        this.state = {}
    }
    componentDidMount(){
        this.updateFrames(this.props)
    }
    componentWillUnmount(){
        if (this.cancelLoadFrames) {
            this.cancelLoadFrames();
        }
    }
    componentWillReceiveProps(newProps){
        this.updateFrames(newProps);
    }
    updateFrames(props){
        if (this.cancelLoadFrames) {
            this.cancelLoadFrames();
        }
        if (props.stack.length === 0) {
            this.setState({
                framesToDisplay: null
            })
            return;
        }
        this.cancelLoadFrames = getUniqueFrameFilenamesToDisplay(props.stack, props.selectedIndex, (framesToDisplay) => {
            this.setState({framesToDisplay})
        })
    }
    render(){
        if (!this.state.framesToDisplay) {
            return null;
        }
        var children = []
        var previousFrameIndex = 0;
        this.state.framesToDisplay.forEach((frameItem, i) => {
            if (frameItem.index > previousFrameIndex + 1) {
                children.push(<span key={"frame-separator-a-" + i}>&nbsp;&lt; …</span>)
            }
            if (frameItem.index !== 0){
                children.push(<span key={"frame-separator-b-" + i}>&lt;&nbsp;</span>)
            }
            children.push(<span
                    key={"filename-" + frameItem.index}
                    className={"call-stack-path__item " + (frameItem.isSelected ? "call-stack-path__item--selected" : "")}
                    onClick={() => this.props.onFrameIndexSelected(frameItem.index)}
                    onMouseEnter={() => this.props.onFrameIndexHovered(frameItem.index)}
                    onMouseLeave={() => this.props.onFrameIndexHovered(null)}>
                    {frameItem.resolvedFrame.uiFileName}
                &nbsp;
            </span>)
        })

        return <span className="call-stack-path">{children}</span>
    }
}

function getUniqueFrameFilenamesToDisplay(stack, selectedIndex, callback){
    const NUM_OF_FRAMES_TO_SHOW = 3;

    var canceled = false;
    var framesToDisplay = [];
    var cancelResolveFrame = resolveFrame(stack[selectedIndex], (err, resolvedFrame) => {
        addFrame(resolvedFrame, selectedIndex)
        lookForDifferentFile({}, 0)
    })

    function lookForDifferentFile(previousFrame, indexInStack){
        if (indexInStack === selectedIndex) {
            indexInStack++;
        }
        if (framesToDisplay.length === NUM_OF_FRAMES_TO_SHOW || indexInStack >= stack.length) {
            if (canceled) {
                return /* I'm not sure why this is necessary, but it is for some reason */
            }
            callback(framesToDisplay)
        }
        else {
            cancelResolveFrame = resolveFrame(stack[indexInStack], (err, resolvedFrame) => {
                if (resolvedFrame.fileName !== previousFrame.fileName || selectedIndex === indexInStack) {
                    addFrame(resolvedFrame, indexInStack)
                }

                lookForDifferentFile(resolvedFrame, indexInStack + 1)
            })
        }
    }

    function addFrame(resolvedFrame, indexInStack){
        framesToDisplay.push({
            isSelected: indexInStack === selectedIndex,
            resolvedFrame,
            index: indexInStack,
            frameString: stack[indexInStack]
        })
        framesToDisplay = _.sortBy(framesToDisplay, "index") // need to sort because selected frame is inserted at start
        framesToDisplay = framesToDisplay.filter(function preventIdenticalAdjecentFiles(frameItem, i){
            if (frameItem.isSelected) {
                return true;
            }
            var previousFrameItem = framesToDisplay[i - 1]
            var nextFrameItem = framesToDisplay[i + 1]
            var previousFrameWasDifferent = doFileNamesDiffer(previousFrameItem, frameItem)
            if (!previousFrameWasDifferent) {
                return false
            }
            if (nextFrameItem && nextFrameItem.isSelected){
                return doFileNamesDiffer(frameItem, nextFrameItem)
            }
            return true;

            function doFileNamesDiffer(frameItem1, frameItem2){
                if (!frameItem1 || !frameItem2) {
                    return true;
                }
                return frameItem1.resolvedFrame.fileName !== frameItem2.resolvedFrame.fileName
            }
        })

    }

    return function cancel(){
        canceled = true;
        cancelResolveFrame();
    }
}

class StackFrameSelector extends React.Component {
    constructor(props){
        super(props)
        this.state = {
            showAllFrames: false
        }
    }
    render(){
        const MAX_FRAMES_TO_SHOW = 15

        var self = this;
        var frames = this.props.stack
        var showAllButton = null;
        if (!this.state.showAllFrames){
            var totalNumberOfCallFrames = frames.length;
            frames = frames.slice(0, MAX_FRAMES_TO_SHOW);
            var numberOfFramesHidden = totalNumberOfCallFrames - MAX_FRAMES_TO_SHOW;
            if (numberOfFramesHidden > 0) {
                showAllButton = <a className="fromjs-stack-frame-selector__show-all-button"
                    onClick={() => this.setState({showAllFrames: true})}>
                    Show {numberOfFramesHidden} more call frames
                </a>
            }
        }
        return <div>
            {frames.map(function(frameString, i){
                return <StackFrameSelectorItem
                    key={"stack-frame-selector-item" + i}
                    isSelected={self.props.selectedFrameIndex === i}
                    onMouseEnter={() => self.props.onFrameHovered(i)}
                    onMouseLeave={() => self.props.onFrameHovered(null)}
                    frameString={frameString}
                    onClick={() => self.props.onFrameSelected(i)}
                />
            })}
            {showAllButton}
        </div>
    }
}

class StackFrameSelectorItem extends React.Component {
    constructor(props){
        super(props);
        this.state = {
            resolvedFrame: null
        }
    }
    componentDidMount(){
        this.cancelFrameResolution = resolveFrame(this.props.frameString, (err, resolvedFrame) => {
            this.setState({resolvedFrame})
        })
    }
    componentWillUnmount(){
        if (this.cancelFrameResolution){
            this.cancelFrameResolution()
        }
    }
    render(){
        var className = "fromjs-stack-frame-selector__item " ;
        if (this.props.isSelected) {
            className += "fromjs-stack-frame-selector__item--selected"
        }

        var loadingMessage = null;
        var frameInfo = null;

        var resolvedFrame = this.state.resolvedFrame;

        if (resolvedFrame) {
            var filename = getFilenameFromPath(resolvedFrame.fileName)
            var functionName = resolvedFrame.functionName;
            if (functionName === undefined) {
                functionName = "(anonymous function)"
            }
            frameInfo = <div>
                {functionName}
                <div style={{float: "right"}}>{filename}</div>
            </div>
        } else {
            loadingMessage = "Loading..."
        }

        return <div
            className={className}
            onClick={this.props.onClick}
            onMouseEnter={() => this.props.onMouseEnter()}
            onMouseLeave={() => this.props.onMouseLeave()}>
            {loadingMessage}
            {frameInfo}
        </div>
    }
}

function getFrameFromHTMLFileContentOriginPathItem(originPathItem){
    var origin = originPathItem.origin
    var valueBeforeChar = origin.value.substr(0, originPathItem.characterIndex)

    var splitIntoLines = valueBeforeChar.split("\n")
    var line = splitIntoLines.length;
    var charIndex = _.last(splitIntoLines).length

    return "at initialHtml (" + origin.isHTMLFileContent.filename + ":" + line + ":" + charIndex
}

class ValueEl extends React.Component {
    render(){
        var step = this.props.originPathItem;
        var val = step.origin.value

        return <TextEl
            text={val}
            highlightedCharacterIndex={step.characterIndex}
            onCharacterClick={(charIndex) => this.props.handleValueSpanClick(step.origin,  charIndex)}
        />
    }
}



class TextEl extends React.Component {
    constructor(props){
        super(props)
        this.state = {
            truncateText: true
        }
    }
    shouldComponentUpdate(nextProps, nextState){
        // console.time("TextEl shouldUpdate")
        var shouldUpdate = JSON.stringify(nextProps) !== JSON.stringify(this.props) ||
            JSON.stringify(nextState) !== JSON.stringify(this.state)
        // console.timeEnd("TextEl shouldUpdate")
        return shouldUpdate
    }
    render(){
        var self = this;

        function splitLines(str){
            var lineStrings = str.split("\n")
            var lines = [];
            var charOffset = 0
            lineStrings.forEach(function(lineString, i){
                var isLastLine = i + 1 === lineStrings.length
                var text = lineString + (isLastLine ? "" : "\n");
                var charOffsetStart = charOffset
                var charOffsetEnd = charOffset + text.length;
                lines.push({
                    text: text,
                    lineNumber: i,
                    charOffsetStart: charOffsetStart,
                    charOffsetEnd: charOffsetEnd,
                    containsCharIndex: function(index){
                        return index >= charOffsetStart && index < charOffsetEnd
                    },
                    splitAtCharIndex: function(index){
                        var lineBeforeIndex = text.substr(0, highlightedCharIndex - charOffsetStart);
                        var lineAtIndex = text.substr(highlightedCharIndex - charOffsetStart, 1);
                        var lineAfterIndex = text.substr(highlightedCharIndex + 1 - charOffsetStart)
                        return [{
                            text: lineBeforeIndex,
                            charOffsetStart: charOffsetStart
                        }, {
                            text: lineAtIndex,
                            charOffsetStart: charOffsetStart + lineBeforeIndex.length
                        }, {
                            text: lineAfterIndex,
                            charOffsetStart: charOffsetStart + lineBeforeIndex.length + lineAtIndex.length
                        }]
                    }
                })
                charOffset = charOffsetEnd
            })

            if (charOffset !== str.length){
                throw "looks like sth went wrong?"
            }
            return lines;
        }

        function processChar(char){
            if (char==="\n"){
                char = "\u21B5" // downwards arrow with corner leftwards
            }
            if (char===" ") {
                char = '\xa0'
            }
            if (char==="\t"){
                char = "\xa0\xa0"
            }
            return char
        }
        function charIsWhitespace(char){
            return char === "\t" || char === " "
        }
        function getValueSpan(char, extraClasses, key, onClick, onMouseEnter, onMouseLeave){
            var className = extraClasses;
            if (charIsWhitespace(char)){
                className += " fromjs-value__whitespace-character"
            }

            var processedChar = processChar(char)

            return <span
                className={className}
                onClick={onClick}
                onMouseEnter={onMouseEnter}
                onMouseLeave={onMouseLeave}
                key={key}
            >
                {processedChar}
            </span>
        }
        function getValueSpans(val, indexOffset){
            var els = [];
            for (let index=0; index<val.length; index++){
                var char = val[index]

                els.push(getValueSpan(char, "", index + indexOffset, () => {
                    self.props.onCharacterClick(index + indexOffset)
                }, () => {
                    if (!self.props.onCharacterHover) {return}
                    self.props.onCharacterHover(index + indexOffset)
                },() => {
                    if (!self.props.onCharacterHover) {return}
                    self.props.onCharacterHover(null)
                }))
            }
            return els
        }

        var val = this.props.text

        var self = this;
        var highlightedCharIndex = this.props.highlightedCharacterIndex

        if (highlightedCharIndex === undefined || highlightedCharIndex === null) {
            return <div className="fromjs-value">
                {getValueSpans(val, 0)}
            </div>
        } else {
            var lines = splitLines(val)

            var valBeforeColumn = val.substr(0, highlightedCharIndex);
            var valAtColumn = val.substr(highlightedCharIndex, 1);
            var valAfterColumn = val.substr(highlightedCharIndex+ 1)

            var highlightedCharLineIndex = valBeforeColumn.split("\n").length

            var showFromLineIndex = highlightedCharLineIndex - 2;
            if (showFromLineIndex < 0) {
                showFromLineIndex = 0;
            }
            var showToLineIndex = showFromLineIndex + 3

            if (!this.state.truncateText) {
                showFromLineIndex = 0;
                showToLineIndex = lines.length;
            }

            var linesToShow = lines.slice(showFromLineIndex, showToLineIndex)

            function getLineComponent(line, beforeSpan, afterSpan){
                var valueSpans = []
                if (line.containsCharIndex(highlightedCharIndex)){
                    var chunks = line.splitAtCharIndex(highlightedCharIndex)

                    var textBeforeHighlight = chunks[0].text
                    if (textBeforeHighlight.length > 50 && self.state.truncateText) {
                        var textA = textBeforeHighlight.slice(0, 40)
                        var textB = textBeforeHighlight.slice(textBeforeHighlight.length - 10)
                        valueSpans = [
                            getValueSpans(textA, chunks[0].charOffsetStart),
                            getEllipsisSpan("ellipsis-line-before-highlight"),
                            getValueSpans(textB, chunks[0].charOffsetStart + textBeforeHighlight.length - textB.length)
                        ]
                    } else {
                        valueSpans = valueSpans.concat(getValueSpans(chunks[0].text, chunks[0].charOffsetStart))
                    }

                    valueSpans = valueSpans.concat(getValueSpan(chunks[1].text, "fromjs-highlighted-character", "highlighted-char-key", function(){}, function(){}, function(){}))

                    var restofLineValueSpans;
                    var textAfterHighlight = chunks[2].text;
                    if (textAfterHighlight.length > 60 && self.state.truncateText){
                        restofLineValueSpans = [
                            getValueSpans(chunks[2].text.slice(0, 60), chunks[2].charOffsetStart),
                            getEllipsisSpan("ellipsis-line-after-highlight")
                        ]
                    } else {
                         restofLineValueSpans = getValueSpans(chunks[2].text, chunks[2].charOffsetStart)
                    }
                    valueSpans = valueSpans.concat(restofLineValueSpans)
                } else {
                    valueSpans = getValueSpans(line.text, line.charOffsetStart);
                }
                return <div key={"Line" + line.lineNumber}>
                    {beforeSpan}
                    {valueSpans}
                    {afterSpan}
                </div>
            }

            function getEllipsisSpan(key){
                return <span onClick={() => self.disableTruncateText()} key={key}>...</span>
            }


            var ret = <HorizontalScrollContainer>
                <div className="fromjs-value">
                    <div className="fromjs-value__content" ref={(el) => {
                        this.scrollToHighlightedChar(el, highlightedCharLineIndex);
                    }}>
                        {linesToShow.map((line, i) =>{
                            var beforeSpan = null;
                            if (i === 0 && line.charOffsetStart > 0){
                                beforeSpan = getEllipsisSpan("beforeEllipsis")
                            }
                            var afterSpan = null;
                            if (i === linesToShow.length - 1 && line.charOffsetEnd < val.length) {
                                afterSpan = getEllipsisSpan("afterEllipsis")
                            }
                            return getLineComponent(line, beforeSpan, afterSpan)
                        })}
                    </div>
                </div>
            </HorizontalScrollContainer>
            return ret;
        }
    }
    scrollToHighlightedChar(el, highlightedCharLineIndex){
        if (!el){return}
        if (this.state.truncateText) {return}
        var lineHeight = 18;
        var lineAtTop = highlightedCharLineIndex - 4;
        if (lineAtTop < 0) {
            lineAtTop = 0;
        }

        el.scrollTop = lineAtTop * lineHeight;
    }
    disableTruncateText(){
        if (this.props.text.length > 20000) {
            alert("Refusing to expand text longer than 20,000 characters. It will just crash your browser.");
            return
        }
        this.setState({truncateText: false})
    }
}


const MAX_LINES_TO_SHOW_BEFORE_AND_AFTER = 200;
class StackFrame extends React.Component {
    constructor(props){
        super(props)
        this.state = {
            resolvedFrame: null,
            truncate: true
        }
    }
    componentDidMount(){
        this.cancelFrameResolution = resolveFrame(this.props.frame, (err, resolvedFrame) => {
            this.setState({resolvedFrame})
        })
    }
    componentWillUnmount(){
        if (this.cancelFrameResolution){
            this.cancelFrameResolution()
        }
    }
    render(){
        function processFrameString(str){
            return str
                .replace(/ /g, '\xa0') //nbsp
                .replace(/\t/g, '\xa0\xa0')
        }

        if (this.state.resolvedFrame === null) {
            return <div style={{padding: 5, paddingLeft: 10}}>Loading...</div>
        }

        var frame = this.state.resolvedFrame;
        var self = this;

        var barSpan = <span className="fromjs-stack__code-column"></span>
        var originPathItem = this.props.originPathItem;

        var highlighNthCharAfterColumn = null;
        if (this.props.frameIndex === 0) {
            if (originPathItem.origin.action === "String Literal" ){
                highlighNthCharAfterColumn = "'".length + originPathItem.characterIndex
            }
            if (originPathItem.origin.action === "Initial Page HTML"){
                highlighNthCharAfterColumn = 0;
                barSpan = null;
            }
        }

        var highlightClass = "fromjs-highlighted-character"
        var hasHighlight = highlighNthCharAfterColumn !== null
        if (!hasHighlight) {
            highlighNthCharAfterColumn = 0
            highlightClass = ""
        }

        highlighNthCharAfterColumn = adjustColumnForEscapeSequences(frame.line.substr(frame.columnNumber), highlighNthCharAfterColumn)
        var strBetweenBarAndHighlight = frame.line.substring(frame.columnNumber, frame.columnNumber + highlighNthCharAfterColumn)

        // If strings are too long and would hide highlighted content truncate them
        var strBeforeBar = frame.line.substr(0, frame.columnNumber)
        if (strBeforeBar.length > 50 && this.state.truncate) {
            strBeforeBar = strBeforeBar.substr(0, 10) + "..." + strBeforeBar.substr(strBeforeBar.length - 20)
        }
        if (strBetweenBarAndHighlight.length > 50 && this.state.truncate) {
            strBetweenBarAndHighlight = strBetweenBarAndHighlight.substr(0, 10) + "..." + strBetweenBarAndHighlight.substr(strBetweenBarAndHighlight.length - 20)
        }

        class LineNumber extends React.Component {
            render(){
                var arrow = null;
                if (this.props.arrow){
                    arrow = <div className={"fromjs-stack__line-number-arrow"}>
                        {this.props.arrow}
                    </div>
                }
                return <span
                    className={"fromjs-stack__line-number " + (this.props.arrow ? "fromjs-stack__line-number--has-arrow": "")}>
                    <span className="fromjs-stack__line-number-text">{this.props.lineNumber}</span>
                    {arrow}
                </span>
            }
        }

        function getLine(lineStr, lineNumber, arrow){
            return <div key={"line" + lineNumber}>
                <LineNumber lineNumber={lineNumber} arrow={arrow} />
                <span style={{opacity: .75}}>{processFrameString(lineStr)}</span>
            </div>
        }

        function getPrevLines(){
            if (frame.prevLines.length === 0) {
                return [];
            }

            if (self.state.truncate) {
                var previousTwo = _.last(frame.prevLines, 2)

                return previousTwo.map(function(line, i){
                    return getLine(line, frame.lineNumber - i - 1, i === 0 ? "\u25B2" : "")
                })
            } else {
                var prevLinesToShow = frame.prevLines;
                if (prevLinesToShow.length > MAX_LINES_TO_SHOW_BEFORE_AND_AFTER) {
                    prevLinesToShow = frame.prevLines.slice(frame.prevLines.length - MAX_LINES_TO_SHOW_BEFORE_AND_AFTER)
                }
                var linesNotShown = frame.prevLines.length - prevLinesToShow.length;
                return prevLinesToShow.map(function(line, i){
                    return getLine(line, i + 1 + linesNotShown)
                })
            }
        }
        function getNextLines(){
            if (frame.nextLines.length === 0) {
                return []
            }
            if (self.state.truncate) {
                var nextTwo = _.first(frame.nextLines, 2)
                return nextTwo.map(function(line, i){
                    return getLine(line, frame.lineNumber + 1 + i, (i === nextTwo.length - 1) ? "\u25BC" : "");
                })
            } else {
                var nextLinesToShow = frame.nextLines;
                if (frame.nextLines.length > MAX_LINES_TO_SHOW_BEFORE_AND_AFTER) {
                    nextLinesToShow = frame.nextLines.slice(0, MAX_LINES_TO_SHOW_BEFORE_AND_AFTER)
                }
                return nextLinesToShow.map(function(line, i){
                    return getLine(line, i + frame.lineNumber + 1)
                })
            }
        }

        var highlightIndexInLine = frame.columnNumber + highlighNthCharAfterColumn
        var highlightedString = processFrameString(frame.line.substr(highlightIndexInLine, 1));
        if (frame.line.length == highlightIndexInLine) {
            // after last proper char in line, display new line
            highlightedString = "\u21B5"
        }
        if (frame.line.length < highlightIndexInLine) {
            debugger // shoudn't happen
        }

        return <div style={{
                display: "block",
                maxHeight: 18 * 7,
                overflow: "auto"
            }} ref={(el) => this.scrollToLine(el, frame.lineNumber)}>
            <HorizontalScrollContainer>
                <div>
                    <code
                        className={"fromjs-stack__code" + (self.state.truncate ? " fromjs-stack__code--truncated" :"")}
                        onClick={() => {
                            if (self.state.truncate){
                                self.setState({truncate: false})
                            }
                        }}
                    >
                        {getPrevLines()}
                        <div>
                            <LineNumber lineNumber={frame.lineNumber} />
                            <span>
                                {processFrameString(strBeforeBar)}
                            </span>
                            {barSpan}
                            <span>
                                {processFrameString(strBetweenBarAndHighlight)}
                            </span>
                            <span className={highlightClass}>
                                {highlightedString}
                            </span>
                            <span>
                                {processFrameString(frame.line.substr(frame.columnNumber + highlighNthCharAfterColumn + 1))}
                            </span>
                        </div>
                        {getNextLines()}
                    </code>
                </div>
            </HorizontalScrollContainer>
        </div>
    }
    scrollToLine(el, lineNumber){
        if (el === null){
            return;
        }
        if (this.state.truncate) {
            return;
        }
        var linesNotShownBefore = this.state.resolvedFrame.prevLines.length - MAX_LINES_TO_SHOW_BEFORE_AND_AFTER;
        if (linesNotShownBefore < 0){
            linesNotShownBefore = 0;
        }

        var lineHeight = 18;
        var scrollToLine = lineNumber - 4 - linesNotShownBefore;
        if (scrollToLine < 0){
            scrollToLine = 0;
        }
        el.scrollTop = scrollToLine * lineHeight;
    }
}

class HorizontalScrollContainer extends React.Component {
    render(){
        return <div className="fromjs-horizontal-scroll-container">
            <div>
                {this.props.children}
            </div>
        </div>
    }
}

class ElementOriginPath extends React.Component {
    constructor(props){
        super(props)

        this.state = {
            characterIndex: getDefaultInspectedCharacterIndex(props.el.outerHTML),
            previewCharacterIndex: null,
            rootOrigin: null,
            originPathKey: null,
            previewOriginPathKey: null,
            originPath: null,
            previewOriginPath: null
        }
    }
    componentDidMount(){
        this.componentWillUpdate(this.props, this.state, true);
    }
    componentWillReceiveProps(nextProps) {
        if (nextProps.el.__fromJSElementId !== this.props.el.__fromJSElementId){
            this.setState({
                rootOrigin: null,
                characterIndex: getDefaultInspectedCharacterIndex(nextProps.el.outerHTML),
            })
        }
    }
    componentWillUpdate(nextProps, nextState, forceUpdate) {
        if (nextState.previewCharacterIndex === this.state.previewCharacterIndex &&
            nextState.characterIndex === this.state.characterIndex &&
            nextState.rootOrigin === this.state.rootOrigin &&
            nextProps.el.__fromJSElementId === this.props.el.__fromJSElementId &&
            forceUpdate !== true) {
            return
        }

        if (this.cancelSelectionGetOriginKeyAndPath) {
            this.cancelSelectionGetOriginKeyAndPath();
        }
        if (this.cancelPreviewGetOriginKeyAndPath) {
            this.cancelPreviewGetOriginKeyAndPath();
        }

        if (nextState.previewCharacterIndex !== null) {
            // We don't reset the state because we want to keep the current UI visible until the new data comes in

            this.cancelPreviewGetOriginKeyAndPath = this.getOriginKeyAndPath(nextProps, nextState, nextState.previewCharacterIndex, (key, originPath) => {
                var setState = () => this.setState({
                    previewOriginPath: originPath,
                    previewOriginPathKey: key
                })
                if (originPath) {
                    var lastStep = _.last(originPath)
                    var origin = lastStep.origin
                    // resolve frame so it's cached when we display it, so you don't get the "loading..." message
                    var frameString;
                    if (origin.isHTMLFileContent) {
                        frameString = getFrameFromHTMLFileContentOriginPathItem(lastStep)
                    } else {
                        frameString = _.first(origin.stack)
                    }

                    if (frameString !== undefined) {
                        resolveFrame(frameString, setState)
                    } else {
                        setState();
                    }
                } else {
                    setState()
                }
            }, () => {
                // if getting the origin path is taking a while show the loading message
                this.setState({
                    previewOriginPath: null,
                    previewOriginPathKey: null,
                    originPath: null,
                    originPathKey: null
                })
            })
        } else {
            // Don't reset yet so it doesn't flash the previous value, instead we want to continue showing the
            // preview value
            this.cancelSelectionGetOriginKeyAndPath = this.getOriginKeyAndPath(nextProps, nextState, nextState.characterIndex, (key, originPath) => this.setState({
                originPathKey: key,
                originPath: originPath,
                previewOriginPathKey: null,
                previewOriginPath: null
            }))
        }
    }
    getOriginKeyAndPath(props, state, characterIndex, callback, onSlowResponse){
        var canceled = false;
        var slowResponseTimeout = setTimeout(onSlowResponse, 300)
        this.getOriginPathKey(props, state, characterIndex, key => {
            this.getOriginPath(props, state, characterIndex, originPath => {
                if (canceled) {return}
                clearTimeout(slowResponseTimeout);
                callback(key, originPath)
            })
        })
        return function cancel(){
            clearTimeout(slowResponseTimeout);
            canceled = true;
        }
    }
    componentWillUnmount(){
        if (this.cancelGetRootOriginAtChar) {
            this.cancelGetRootOriginAtChar();
        }
        if (this.cancelSelectionGetOriginKeyAndPath) {
            this.cancelSelectionGetOriginKeyAndPath();
        }
        if (this.cancelPreviewGetOriginKeyAndPath) {
            this.cancelPreviewGetOriginKeyAndPath();
        }
    }
    render(){
        var showPreview = this.state.previewOriginPath;
        var originPath = <div style={{display: showPreview ? "none" : "block"}}>
            <OriginPath
                originPath={this.state.originPath}
                key={this.state.originPathKey}
                handleValueSpanClick={(origin, characterIndex) => {
                    this.props.onNonElementOriginSelected()
                    currentInspectedPage.send("UISelectNonElementOrigin")

                    this.setState({
                        rootOrigin: origin,
                        characterIndex
                    })
                }}
            />
        </div>

        var previewOriginPath = null;
        if (showPreview) {
            previewOriginPath = <OriginPath
                originPath={this.state.previewOriginPath}
                key={this.state.previewOriginPathKey}
            />
        }

        var showUpButton = typeof this.props.goUpInDOM === "function"
        var upButton = null;
        if (showUpButton && !window.disableSelectParentElement){
            upButton = <div style={{position: "absolute", top: 0, right: 0, border: "1px solid #eee"}}>
                <button
                    data-tip={"Inspect parent element"}
                    onClick={() => this.props.goUpInDOM() }
                    className={"fromjs-go-up-button"}
                    >
                    {"\u21e7"}
                </button>
            </div>
        }

        var onCharacterClick = (characterIndex) => this.setState({
            characterIndex,
            previewCharacterIndex: null,
            originPathKey: null,
            originPath: null
        })
        if (!this.props.isPreviewElement) {
            window.e2eTestSimulateInpsectCharacter = onCharacterClick
        }

        return <div>
            <div style={{padding: 10}}>
                <div style={{fontWeight: "bold", fontSize: 20, marginBottom: 20}}>
                    Where does this character come from?
                </div>
                <div style={{position: "relative"}}>
                    <div style={{border: "1px solid #ddd",
                        width: showUpButton ? "calc(100% - 30px)" : "100%"}}
                        data-test-marker-inspected-value>
                        <TextEl
                            text={this.getInspectedValue()}
                            highlightedCharacterIndex={this.state.characterIndex}
                            onCharacterClick={onCharacterClick}
                            onCharacterHover={(characterIndex) => {
                                if (isMobile()) { return }
                                this.setState({previewCharacterIndex: characterIndex})
                            }}
                        />
                    </div>
                    {upButton}
                </div>
            </div>
            <hr/>
            <div style={{padding: 10}}>
                {originPath}
                {previewOriginPath}
            </div>
        </div>

    }
    originComesFromElement(props, state){
        return state.rootOrigin === null
    }
    getInspectedValue(){
        if (this.state.rootOrigin){
            return this.state.rootOrigin.value
        } else if (this.props.el) {
            var outerHtml = this.props.el.outerHTML
            if (this.props.el.tagName === "BODY") {
                // contains the FromJS UI, which we don't want to show
                var fromJSHtml = document.querySelector(".fromjs-outer-container").outerHTML
                var fromJSStartInBody = outerHtml.indexOf(fromJSHtml)
                var fromJSEndInBody = fromJSStartInBody + fromJSHtml.length
                outerHtml = outerHtml.slice(0, fromJSStartInBody) + outerHtml.slice(fromJSEndInBody)
            }
            return outerHtml
        }
        return null;
    }
    getOriginPath(props, state, characterIndex, callback){
        if (characterIndex === null){
            // characterIndex should never be null, but right now it is sometimes
            callback(null)
            return;
        }

        var isCanceled = false

        this.getOriginAndCharacterIndex(props, state, characterIndex, function(info){
            if (isCanceled) {
                return;
            }
            currentInspectedPage.send("whereDoesCharComeFrom", info.origin.id, info.characterIndex, function(){
                if (!isCanceled) {
                    callback.apply(this, arguments)
                }
            })
        })

        return function cancel(){
            isCanceled = true;
        }
    }
    getOriginPathKey(props, state, characterIndex, callback){
        this.getOriginAndCharacterIndex(props, state, characterIndex, function(info){
            callback(JSON.stringify({
                originId: info.origin.id,
                characterIndex: info.characterIndex
            }))
        })
    }
    getOriginAndCharacterIndex(props, state, characterIndex, callback){
        characterIndex = parseFloat(characterIndex);
        if (this.originComesFromElement(props, state)) {
            this.cancelGetRootOriginAtChar = currentInspectedPage.send("getRootOriginAtChar", props.el.__fromJSElementId, characterIndex, function(rootOrigin){
                callback(rootOrigin)
            });
        } else {
            callback({
                characterIndex: characterIndex,
                origin: state.rootOrigin
            })
        }
    }
}

class ElementMarker extends React.Component {
    shouldComponentUpdate(newProps){
        return this.props.el !== newProps.el;
    }
    render(){
        if (this.props.el === null) {
            return null;
        }
        var rect = this.props.el.getBoundingClientRect()
        var style = {
            ...this.props.style,
            left: rect.left + document.body.scrollLeft,
            top: rect.top + document.body.scrollTop,
            height: rect.height,
            width: rect.width
        }
        return <div style={style} className="fromjs-element-marker"></div>
    }
}

export class SelectedElementMarker extends React.Component {
    render(){
        return <ElementMarker el={this.props.el} style={{outline: "2px solid #0088ff"}} />
    }
}

export class PreviewElementMarker extends React.Component {
    render(){
        return <ElementMarker el={this.props.el} style={{outline: "2px solid green"}} />
    }
}

class Intro extends React.Component {
    render(){
        var browserIsChrome = /chrom(e|ium)/.test(navigator.userAgent.toLowerCase());
        var notChromeMessage = null
        if (!browserIsChrome || isMobile()) {
            notChromeMessage = <div style={{border: "2px solid red", padding: 10}}>
                FromJS is currently built to only work in Chrome Desktop.
            </div>
        }
        return <div className="fromjs-intro">
            {notChromeMessage}
            <h2>How to use FromJS</h2>
            <p>
                FromJS helps you understand how an app works by showing how its UI relates to the source code.
            </p>
            <p>
                Select a DOM element on the left to see where its
                content came from. This could be a string in the JavaScript code,
                localStorage data, or directly from the HTML file.
            </p>

            <p>
                <a href="https://github.com/mattzeunert/fromjs/issues" target="_blank">
                    Report an issue
                </a>
            </p>

            <p>
                <a href="https://github.com/mattzeunert/fromjs"  target="_blank">Github</a>
                &nbsp;
                &ndash;
                &nbsp;
                <a href="http://www.fromjs.com/" target="_blank">FromJS.com</a>
                &nbsp;
                &ndash;
                &nbsp;
                <a href="https://twitter.com/mattzeunert" target="_blank">Twitter</a>
            </p>
        </div>
    }
}

export class FromJSView extends React.Component {
    constructor(props){
        super(props)
        this.state = {
            el: null,
            previewEl: null,
            // this shoudldn't be needed, should just reset state.el, but right now that wouldn't work
            nonElementOriginSelected: null
        }

        currentInspectedPage = new RoundTripMessageWrapper(window.parent, "IFrame")
        setTimeout(function(){
            currentInspectedPage.send("InspectorReady", function(){})
        })

        currentInspectedPage.on("selectElement", (el) => {
            this.setState({
                el: el,
                nonElementOriginSelected: false
            })
        })

        var onPreviewElement = (el) => {
            // Delay to prevent setting null inbetween when exiting one element and then entering another
            this.setState({previewEl: el})
        }
        onPreviewElement = _.debounce(onPreviewElement, 10)

        currentInspectedPage.on("previewElement", onPreviewElement, 10)

        // ReactTooltip doesn't respond to UI changes automatically
        setInterval(function(){
            ReactTooltip.rebuild()
        }, 100)
    }
    render(){
        var preview = null;
        var info = null;
        var selectionMarker = null;
        var previewMarker = null;
        var intro = null;

        var showPreview = this.state.previewEl !== null && (!this.state.el || this.state.previewEl.__fromJSElementId !== this.state.el.__fromJSElementId)

        if (showPreview){
            preview = <ElementOriginPath
                el={this.state.previewEl}
                goUpInDOM={() => "can't call this function, but needs to be there so button is shown"}
                isPreviewElement={true}
                />
        }
        if (this.state.el) {
            var goUpInDOM = null
            if (!this.state.nonElementOriginSelected && this.state.el.tagName !== "BODY") {
                goUpInDOM = () => currentInspectedPage.send("UISelectParentElement")
            }
            info = <div style={{display: showPreview ? "none" : "block"}}>
                <ElementOriginPath
                    el={this.state.el}
                    onNonElementOriginSelected={() => this.setState({nonElementOriginSelected: true})}
                    goUpInDOM={goUpInDOM} />
            </div>
        }

        if (this.state.el && !this.state.nonElementOriginSelected) {
            // selectionMarker = <SelectedElementMarker el={this.state.el} />
        }

        if (!this.state.previewEl && !this.state.el){
            intro = <Intro />
        }


        return <div>
            <div id="fromjs" className="fromjs">
                <button
                    style={{display: window.disableCloseInspectorElement ? "none": "block"}}
                    onClick={() => currentInspectedPage.send("UICloseInspector")}
                    className="toggle-inspector-button close-inspector-button">

                </button>
                {intro}
                {preview}

                {info}

                {/* Add some spacing since it seems you can't scroll down all the way*/}
                {isMobile() ? <div><br/><br/><br/></div> : null}
                <ReactTooltip effect="solid" />
            </div>
            {previewMarker}
            {selectionMarker}
        </div>
    }
}
