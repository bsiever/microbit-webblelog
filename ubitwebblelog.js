
/**
 * JavaScript functions for interacting with micro:bit microcontrollers over WebBluetooth
 * (Only works in Chrome browsers;  Pages must be either HTTPS or local)
 */


/**
 * Download the given string data as a file
 * @param {*} data String (file contents) to download
 * @param {*} filename The file name (include extension)
 * @param {*} type the extension (".csv")
 * @private
 */
function download(data, filename, type) {
    var file = new Blob([data], {type: type});
    if (window.navigator.msSaveOrOpenBlob) // IE10+
        window.navigator.msSaveOrOpenBlob(file, filename);
    else { // Others
        var a = document.createElement("a"),
                url = URL.createObjectURL(file);
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        setTimeout(function() {
            document.body.removeChild(a);
            window.URL.revokeObjectURL(url);  
        }, 0); 
    }
}

const onDataTIMEOUT = 1000          // Timeout after 1 second of no data (and expecting more)
const dataBurstSIZE = 100           // Number of packets to request at in a burst 
const progressPacketThreshold = 10  // More than 10 packets and report progress of transfer

const SERVICE_UUID     = "accb4ce4-8a4b-11ed-a1eb-0242ac120002"  // BLE Service
const serviceCharacteristics = new Map( 
    [
     ["accb4f64-8a4b-11ed-a1eb-0242ac120002", "securityChar"],    // Security	Read, Notify
     ["accb50a4-8a4b-11ed-a1eb-0242ac120002", "passphraseChar"],  // Passphrase	Write
     ["accb520c-8a4b-11ed-a1eb-0242ac120002", "dataLenChar"],     // Data Length	Read, Notify
     ["accb53ba-8a4b-11ed-a1eb-0242ac120002", "dataChar"],        // Data	Notify
     ["accb552c-8a4b-11ed-a1eb-0242ac120002", "dataReqChar"],     // Data Request	Write
     ["accb5946-8a4b-11ed-a1eb-0242ac120002", "eraseChar"],       // Erase	Write
     ["accb5be4-8a4b-11ed-a1eb-0242ac120002", "usageChar"],       // Usage	Read, Notify
     ["accb5dd8-8a4b-11ed-a1eb-0242ac120002", "timeChar"],        // Time	Read
     ["accb5f72-8a4b-11ed-a1eb-0242ac120002", "dataReadChar"]     // Data Read
    ]);


/**
 * Retrieve task
 * @private
 */
class retrieveTask {
    /**
     * Task for the retrieval queue for data
     * @param {*} start 16-byte aligned start index (actual data index is "start*16")
     * @param {*} length Number of 16-byte segments to retrieve 
     * @param {*} progress Progress of the task (0-100) at the start of this bundle or null (-1) if not shown
     * @param {*} final indicator of final bundle for request
     * @param {*} success Callback function for success (completion)
     */
    constructor(start, length, progress = -1, final, success = null) {
        this.start = start    // Start index of the data
        this.segments = new Array(length) // Segment data 
        this.processed = 0   // Number of segments processed
        this.progress = progress
        this.final = final 
        this.success = success
    }
}

/**
 * Class to manage an individual micro:bit device
 */
class uBit extends EventTarget {
    /**
     * Constructor for a micro:bit object
     * @param {*} manager 
     * @private
     */
    constructor(manager) {
        super()

        // Device Identification data 
        this.id = null;
        this.label = null; 
        this.name = null;

        // Authentication data
        this.password = null
        this.passwordAttempts = 0

        // Object ownership 
        this.manager = manager

        // "CSV" raw packets and overall length of data on device
        this.rawData = []
        this.dataLength = null

        // Managing Data retrieval 
        this.onDataTimeoutHandler = -1  // Also tracks if a read is in progress
        this.retrieveQueue = []

        // Parsing data
        this.nextDataAfterReboot = false
        this.bytesProcessed = 0
        this.headers = []
        this.indexOfTime = 0
        this.fullHeaders = []
        this.rows = [] 

        // Connection Management
        this.firstConnectionUpdate = false

        // Bind Callback methods (all BLE callbacks)
        this.onConnect = this.onConnect.bind(this)
        this.onDataLength = this.onDataLength.bind(this)
        this.onSecurity = this.onSecurity.bind(this)
        this.onData = this.onData.bind(this)
        this.onUsage = this.onUsage.bind(this)
        this.onDisconnect = this.onDisconnect.bind(this)

        // Bind timeout callbacks
        this.onDataTimeout = this.onDataTimeout.bind(this)

        // Bind internal callbacks
        this.onConnectionSyncCompleted = this.onConnectionSyncCompleted.bind(this)

        // Connection state management setup 
        this.disconnected()
    }

    /**
     * 
     * @returns {string[]} Array of headers for the data
     */
    getHeaders() {
        return this.fullHeaders
    }

    /**
     * 
     * @returns {number} The number of rows of data
     */
    getDataLength() {
        return this.rows.length
    }

    /**
     * 
     * @param {number} start Start row (inclusive)
     * @param {number} end End row (exclusive)
     * @returns Rows from start (inclusive) to end (inclusive)
     */
    getData(start = 0, end = this.rows.length) {
        return this.rows.slice(start, end)
    }

    /**
     * Set the label for the device
     * @param {string} label 
     */
    setLabel(label) {
        this.label = label
    }

    /**
     * 
     * @returns {string} The label for the device
     */
    getLabel() {
        return this.label || this.name
    }

    /**
     * Download the data as a CSV file
     * @param {string} filename The name of the file to download (no extension)
     */
    download(filename) {
        let headers = this.fullHeaders.join(",") + "\n"
        let data = d.rows.map( r => r.join(",")).join("\n")
        download(headers+data, filename+".csv", "csv")
    }

    /**
     * Request an erase (if connected & authorized)
     */
    sendErase() {
        //console.log(`sendErase`)
        if(this.device && this.device.gatt && this.device.gatt.connected) {
            let dv = new DataView(new ArrayBuffer(5))
            let i = 0
            for(let c of "ERASE") {
                dv.setUint8(i++, c.charCodeAt(0))
            }
            this.eraseChar.writeValue(dv)
        }
    }

    /**
     * Request authorization (if connected)
     * 
     * A correct password will be retained for future connections
     * 
     * @param {string} password The password to send
     */
    sendAuthorization(password) {
        //console.log(`sendAuthorization: ${password}`)
        if(this.device && this.device.gatt && this.device.gatt.connected) {
            let dv = new DataView(new ArrayBuffer(password.length))
            let i = 0
            for(let c of password) {
                dv.setUint8(i++, c.charCodeAt(0))
            }
            this.passphraseChar.writeValue(dv)
            this.password = password
        }
    }

    /**
     * Request a disconnect
     */
    disconnect() {
        if(this.device && this.device.gatt && this.device.gatt.connected) {
            this.device.gatt.disconnect()
        }
    }

    /* ******************* Private Methods ******************* */

    /**
     * Clear the "onData" timeout
     * @private
     */
    clearDataTimeout() {
        // console.log(`clearDataTimeout: handler ID ${this.onDataTimeoutHandler}`)
        if(this.onDataTimeoutHandler!=-1) {
            clearTimeout(this.onDataTimeoutHandler)
            this.onDataTimeoutHandler = -1
        }
    }

    /**
     * set the "onData" timeout
     * @private
     */
    setDataTimeout() {
        this.clearDataTimeout()
        this.onDataTimeoutHandler = setTimeout(this.onDataTimeout, onDataTIMEOUT)
        // console.log(`setDataTimeout: handler ID ${this.onDataTimeoutHandler}`)
    }

    /**
     * Callback for "onData" timeout (checks to see if transfer is complete)
     * @private
     */
    onDataTimeout() {
        // Stuff to do when onData is done
        if(this.onDataTimeoutHandler!=-1) {
            console.log("onDataTimeout")
            this.clearDataTimeout()
            this.checkChunk() 
        } 
    }

    /**
     * Do a BLE request for the data (to be streamed)
     * @param {int} start 16-byte aligned start index (actual data index is "start*16")
     * @param {int} length Number of 16-byte segments to retrieve
     * @private
     */
    async requestSegment(start, length) {
        // console.log(`requestSegment: Requesting @ ${start} ${length} *16 bytes`)
        if(this.device && this.device.gatt && this.device.gatt.connected) {
            let dv = new DataView(new ArrayBuffer(8))
            dv.setUint32(0, start*16, true)
            dv.setUint32(4, length*16, true)
            await this.dataReqChar.writeValue(dv)
            this.clearDataTimeout()
            this.setDataTimeout()    
        }
    }

    /**
     * 
     * @param {int} progress Progress of the task (0-100) 
     * @private
     */
    notifyDataProgress(progress) {
        this.manager.dispatchEvent(new CustomEvent("progress", {detail: {device:this, progress:progress}}))
    }

    /**
     * Retrieve a range of data and re-request until it's all delivered.
     * Assuming to be non-overlapping calls.  I.e. this won't be called again until all data is delivered
     * @param {*} start 16-byte aligned start index (actual data index is "start*16")
     * @param {*} length Number of 16-byte segments to retrieve
     * @private
     */
    retrieveChunk(start, length, success = null) {
        //console.log(`retrieveChunk: Retrieving @${start} ${length} *16 bytes`)
        if(start*16>this.dataLength) {
            console.log(`retrieveChunk: Start index ${start} is beyond end of data`)
            return
        }  

        if(start + length > Math.ceil(this.dataLength/16)) {  
            console.log(`retrieveChunk: Requested data extends beyond end of data`)
           // return
        }  

        // Break it down into smaller units if needed
        let noPending = this.retrieveQueue.length == 0
        let progressIndicator = length>progressPacketThreshold
        let numBursts = Math.ceil(length / dataBurstSIZE)
        let remainingData = length
        let thisRequest = 0
        while(remainingData > 0) {
            let thisLength = Math.min(remainingData, dataBurstSIZE)
            let finalRequest = thisRequest == numBursts-1
            let newTask = new retrieveTask(start, 
                                            thisLength, 
                                            progressIndicator ? Math.floor(thisRequest/numBursts*100) : -1, 
                                            finalRequest, 
                                            finalRequest ? success : null)
            this.retrieveQueue.push(newTask)
            start += thisLength
            remainingData -= thisLength
            thisRequest++
        }

        // If nothing is being processed now, start it
        if(noPending) {
            this.startNextRetrieve()
        }
    }

    /**
     * Callback of actions to do on connection
     * @param {BLEService} service 
     * @param {BLECharacteristics} chars 
     * @param {BLEDevice} device 
     * @private
     */
    async onConnect(service, chars, device) {
        // Add identity values if not already set (neither expected to change)
        this.id = this.id || device.id   
        this.name = this.name || device.name 

        // Bluetooth & connection configuration
        this.device = device 
        this.chars = chars 
        this.service = service
        this.passwordAttempts = 0
        this.nextDataAfterReboot = false
        this.firstConnectionUpdate = true

        this.chars.forEach(element => {
            let charName = serviceCharacteristics.get(element.uuid)
            if(charName!=null) {
                this[charName] = element
            } else {
                console.log(`Char not found: ${element.uuid}`)
            }
        });

        // Connect / disconnect handlers
        this.manager.dispatchEvent(new CustomEvent("connected", {detail: {device: this}}))

        this.device.addEventListener('gattserverdisconnected', () => {
            this.onDisconnect()}, {once:true});

        this.securityChar.addEventListener('characteristicvaluechanged', this.onSecurity)
        await this.securityChar.startNotifications()
    }
   
    async readData(start, length) {
        let dv = new DataView(new ArrayBuffer(4))
        dv.setUint32(0, start, true)
        // Request start address
        await this.dataReadChar.writeValue(dv)
        
        let result = await this.dataReadChar.readValue() 
        let startIndex = result.getUint32(0,true)
        console.log(`Start index: ${startIndex}`)
        let text =''
        for(let i=4;i<result.byteLength;i++) {
            let val = result.getUint8(i)
            if(val!=0) {
                text += String.fromCharCode(val)
            }
        }
        console.log(text)
        return text
    }

    /**
     * Callback of actions to do when authorized
     * @private
     */
    async onAuthorized() {
        // Subscribe to characteristics / notifications
        // Initial reads (need to be before notifies
        let time = await this.timeChar.readValue() 
        let msTime = Math.round(Number(time.getBigUint64(0,true))/1000)  // Conver us Time to ms

        // Compute the date/time that the micro:bit started in seconds since epoch start (as N.NN s)
        this.mbRebootTime = Date.now() - msTime  

        // this.dataChar.addEventListener('characteristicvaluechanged', this.onData)
        // await this.dataChar.startNotifications()

        this.usageChar.addEventListener('characteristicvaluechanged', this.onUsage)
        await this.usageChar.startNotifications()

        // Enabling notifications will get current length;
        // Getting current length will retrieve all "new" data since last retrieve
        // this.dataLenChar.addEventListener('characteristicvaluechanged', this.onDataLength)
        // await this.dataLenChar.startNotifications()        
    }
       
    /**
     * 
     * @param {event} event The event data
     * @private
     */
    onDataLength(event) {
        // Updated length / new data
        let length = event.target.value.getUint32(0,true)
        // console.log(`New Length: ${length} (was ${this.dataLength})`)

        // If there's new data, update
        if(this.dataLength != length) {

            // Probably erased.  Retrieve it all
            if(length<this.dataLength) {
                console.log("Log smaller than expected.  Retrieving all data")
                this.rawData = []
                this.dataLength = 0
                this.bytesProcessed = 0 // Reset to beginning of processing
                this.discardRetrieveQueue() // Clear any pending requests

                this.bytesProcessed = 0
                this.headers = []
                this.indexOfTime = 0
                this.fullHeaders = []
                this.rows = [] 

                this.manager.dispatchEvent(new CustomEvent("graph cleared", {detail: {device: this}}))
            }

            // Get the index of the last known value (since last update)
            // floor(n/16) = index of last full segment 
            // ceil(n/16) = index of last segment total (or count of total segments)
            let lastIndex = Math.floor(this.dataLength/16)  // Index of first non-full segment
            let totalSegments = Math.ceil(length/16) // Total segments _now_
            this.dataLength = length;
            // Retrieve checks dataLength;  Must update it first;  
            this.retrieveChunk(lastIndex, 
                                totalSegments-lastIndex, 
                                this.onConnectionSyncCompleted)
        }
    }

    /**
     * Update data with wall clock time.
     * @private
     */
    processTime() {
        // Add in clock times (if possible)
        // console.log("Adding times")
        if(this.firstConnectionUpdate==false && this.indexOfTime!=-1) {
            let start = this.rows.length-1
            // console.log(`Start: ${start}`)
            // Valid index, wtc time is null
            while(start>=0 && this.rows[start][2]==null) {
                // Until a "Reboot" or another time is set
                let sampleTime = this.mbRebootTime + Math.round(this.rows[start][3]*1000)  
                let timeString = new Date(sampleTime).toISOString()             
                // console.log(`Setting time for row ${start} to ${timeString}`)
                this.rows[start][2] = timeString
                this.updatedRow(start)
                // Don't update rows before "Reboot"
                if(this.rows[start][1]!=null) {
                    break;
                }
                //console.log(`Row: ${this.rows[start]}`)   
                start--
            }
        }
    }

    /**
     * Post event to indicate a row of data has changed or been added
     * @private 
     */
    updatedRow(rowIndex) {
        this.manager.dispatchEvent(new CustomEvent("row updated", {detail: {
            device: this, 
            row: rowIndex,
            data: this.rows[rowIndex],
            headers: this.fullHeaders
        }}))
    }

    /**
     * A block of data is ready to be parsed
     * @private
     */
    parseData() {
        //console.log("parseData")

        // Bytes processed always ends on a newline

        let index = Math.floor(this.bytesProcessed/16) 
        let offset = this.bytesProcessed%16

        let partialItem = this.rawData[index].substring(offset)
        let mergedData = partialItem + this.rawData.slice(index+1).join("")
        // console.log(`mergedData: ${mergedData}`)
        let lines = mergedData.split("\n")
        let startRow = this.rows.length
        lines.pop() // Discard the last / partial line
        for(let line of lines) {
            //console.log(`parsing line: ${line}`)
            if(line == "Reboot") {
                //console.dir(`Reboot`)
                this.nextDataAfterReboot = true
            } else if(line.includes("Time")) {
                //console.log(`Header: ${line}`)
                let parts = line.split(",")
                if(parts.length != this.headers.length) {
                    // New Header!
                    this.headers = parts
                    this.indexOfTime = parts.findIndex((element) => element.includes("Time"))
                    this.fullHeaders = ["Microbit Label", "Reboot Before Data", "Time (local)"]
                    if(this.indexOfTime != -1) {
                        this.fullHeaders = this.fullHeaders.concat(parts)
                    } else {
                        // Time then data
                        this.fullHeaders = this.fullHeaders.concat(parts[this.indexOfTime])
                        this.fullHeaders = this.fullHeaders.concat(parts.slice(0, this.indexOfTime))
                        this.fullHeaders = this.fullHeaders.concat(parts.slice(this.indexOfTime+1))
                    }
                    //console.log(`Full Headers now: ${this.fullHeaders}`)
                }
            } else {
                let parts = line.split(",")
                //console.log(`Data: ${parts} ${parts.length} ${this.headers.length}`)
                if(parts.length < this.headers.length) {
                    console.log(`Invalid line: ${line} ${this.bytesProcessed}`)
                } else {
                    let time = null
                    if(this.indexOfTime!=-1) {
                        time = parts[this.indexOfTime]
                    } 
                    parts = parts.slice(0, this.indexOfTime).concat(parts.slice(this.indexOfTime+1))
                    //  name, reboot, local time, time, data...
                    let newRow = [this.label || this.name, this.nextDataAfterReboot ? "true" : null, null, time].concat(parts)
                    // console.log(`New Row: ${newRow}`)
                    this.rows.push(newRow)
                    this.nextDataAfterReboot = false
                }
            }
        }
        this.processTime()
        // Advance by total contents of lines and newlines
        this.bytesProcessed += lines.length + lines.reduce((a, b) => a + b.length, 0)
        // Notify any listeners
        for(let i=startRow; i<this.rows.length; i++) {
            this.updatedRow(i)
        }
    }

    /**
     * Callback when a security message is received
     * @param {event}} event The BLE security data
     * @private 
     */
    onSecurity(event) {
        let value = event.target.value.getUint8()
        if(value!=0) {
            this.onAuthorized()
        } else {
            if(this.password!=null && this.passwordAttempts==0) {
                // If we're on the first connect and we have a stored password, try it
                this.sendAuthorization(this.password)
                this.passwordAttempts++
            } else {
                // Need a password or password didn't work
                this.manager.dispatchEvent(new CustomEvent("unauthorized", {detail: {device: this}}))
            }
        }
    }

    /**
     * Start the next data request (if there is one pending)
     * @private
     */
    startNextRetrieve() {
        // If there's another one queued up, start it
        if(this.retrieveQueue.length>0) {
            // Request the next chunk
            let nextRetrieve = this.retrieveQueue[0]
            this.requestSegment(nextRetrieve.start, nextRetrieve.segments.length)
            // Post the progress of the next transaction
            if(nextRetrieve.progress>=0) {
                this.notifyDataProgress(nextRetrieve.progress)
            }
        } 
    }

    /**
     * Initial data request on connection (or reconnect) is done (or at least being checked)
     * @private
     */
    onConnectionSyncCompleted() {
        if(this.firstConnectionUpdate) {
            //console.log("onConnectionSyncCompleted")
            this.firstConnectionUpdate = false
            this.processTime()
        }
    }

    /**
     * Process the data from a retrieveTask that has completed (all data available)
     * @param {retrieveTask} retrieve The retrieve task to try to check/process
     * @private
     */
    processChunk(retrieve) {
        // If final packet and we care about progress, send completion notification
        // console.log(`processChunk: ${retrieve.progress} ${retrieve.final} ${retrieve.success} ${retrieve.segments.length}`)
        if(retrieve.progress>=0 && retrieve.final) {
            this.notifyDataProgress(100)
        }

        // Pop off the retrieval task
        this.retrieveQueue.shift()

        // Start the next one (if any)
        this.startNextRetrieve()

        // Copy data from this to raw data  
        for(let i=0;i<retrieve.segments.length;i++) {
            if(retrieve.segments[i]==null) {
                console.log(`ERROR: Null segment: ${i}`)
            }
            this.rawData[retrieve.start+i] = retrieve.segments[i]
        }
        this.parseData()

        // If we're done with the entire transaction, call the completion handler if one
        if(retrieve.success) {
            retrieve.success()
        }
    }

    /**
     * A retrieveTask is done.  Check to see if it's complete and ready for processing (if not, make more requests)
     * @private
     */
    checkChunk() {
        // console.log("checkChunk")
        if(this.retrieveQueue.length==0) {
            console.log('No retrieve queue')
            return
        }
        let retrieve = this.retrieveQueue[0]

        // If done
        if(retrieve.processed==retrieve.segments.length) {
            this.processChunk(retrieve)
        } else {
            // Advance to next missing packet
            while(retrieve.processed<retrieve.segments.length && retrieve.segments[retrieve.processed]!=null) {
                retrieve.processed = retrieve.processed+1
            }
            // If there's a non-set segment, request it
            if(retrieve.processed<retrieve.segments.length) {
                // Identify the run length of the missing piece(s)
                let length = 1;
                while(retrieve.processed+length<retrieve.segments.length &&
                    retrieve.segments[retrieve.processed+length]==null ) {
                    length++
                }
                // Request them
                this.requestSegment(retrieve.start+retrieve.processed, length)
            } else {
                // No missing segments. Process it
                this.processChunk(retrieve)
            }
        }
    }

    /**
     * Process the data notification from the device
     * @param {event} event BLE data event is available
     * @private
     */
    onData(event) {
        // Stop any timer from running
        this.clearDataTimeout()
        // If we're not trying to get data, ignore it
        if(this.retrieveQueue.length==0) {
            return;
        }
        // First four bytes are index/offset this is in reply to...
        let dv = event.target.value

        if(dv.byteLength>=4) {
            let index = dv.getUint32(0,true)
            
            let text =''
            for(let i=4;i<dv.byteLength;i++) {
                let val = dv.getUint8(i)
                if(val!=0) {
                    text += String.fromCharCode(val)
                }
            }

            // console.log(`Text at ${index}: ${text}`)
            // console.log(`Hex: ${showHex(dv)}`)

            let retrieve = this.retrieveQueue[0]

// if(Math.random()<.01) {
//     console.log("Dropped Packet")
// } else {

            // console.dir(retrieve)
            let segmentIndex = (index/16 - retrieve.start);
            // console.log(`Index: ${index} Start: ${retrieve.start}  index: ${segmentIndex}`)
            if(segmentIndex == retrieve.processed)
                retrieve.processed++

            if(retrieve.segments[segmentIndex]!=null) {
                console.log(`ERROR:  Segment already set ${segmentIndex}: "${retrieve.segments[segmentIndex]}" "${text}" `)
                if(retrieve.segments[segmentIndex].length!=text.length && retrieve.segments[segmentIndex]!=text) {
                    console.log("Segment is ok (duplicate / overlap")
                } else {
                    console.log("Duplicate segment")
                }
            }
            if(segmentIndex>=0 && segmentIndex<retrieve.segments.length) {
                retrieve.segments[segmentIndex] = text
            } else {
                console.log(`ERROR:  Segment out of range ${segmentIndex} (max ${retrieve.segments.length}`)
            }
//  }  // END Dropped packet test
            // Not done:  Set the timeout
            this.setDataTimeout()
        } else if(event.target.value.byteLength==0) {
            // Done: Do the check / processing (timer already cancelled)
            // console.log("Terminal packet.")
// if(Math.random()<.10) {
            this.checkChunk() 
// } else {
//     // Simulate timeout
//     console.log("Dropped terminal packet")
//     this.setDataTimeout()
// }

        } else {
            console.log(`ERROR:  Unexpected data length ${event.target.value.byteLength}`)
        }
    }

    /**
     * Process an update on the BLE usage characteristics
     * 
     * @param {event} event The BLE event useage data
     * @private
     */
    onUsage(event) {
        let value = event.target.value.getUint16(0, true)/10.0
        this.manager.dispatchEvent(new CustomEvent("log usage", {detail: {device: this, percent: value}} ))
    }

    /**
     * Process an update on the BLE disconnection event
     * @private
     */
    onDisconnect() {
        this.device.gatt.disconnect()
        this.disconnected()
        this.manager.dispatchEvent(new CustomEvent("disconnected", {detail: {device:this}} ))
    }

    /**
     * Discard any pending retrieve tasks (and mark any in-progress as complete)
     * @private
     */
    discardRetrieveQueue() {
        // If there's a transfer in-progress, notify it is completed
        if(this.retrieveQueue.length>0 && this.retrieveQueue[0].progress>=0) {
            this.notifyDataProgress(100)
        }
        while(this.retrieveQueue.pop()) {}
    }

    /**
     * Update state variables for a disconnected state
     * @private
     */
    disconnected() {
        this.device = null
        this.service = null
        this.chars = null
        // Individual characteristics
        this.securityChar = null
        this.passphraseChar = null 
        this.dataLenChar = null 
        this.dataChar = null 
        this.dataReqChar = null
        this.eraseChar = null 
        this.usageChar = null
        this.timeChar = null
        this.dataReadChar = null
        // Update data to reflect what we actually have
        this.dataLength = Math.max(0, (this.rawData.length-1)*16)

        this.discardRetrieveQueue()

        this.mbRebootTime = null
        this.clearDataTimeout()
    }
}

/**
 * Manager for uBit devices
 */
class uBitManager extends EventTarget  {

    /**
     * Constructor a Manager for uBit devices
     */
    constructor() {
        super()

        // Map of devices
        this.devices = new Map()

        this.connect = this.connect.bind(this)
    }

    /**
     * Connect to a device
     */
    async connect() {
        let device = await navigator.bluetooth.requestDevice({filters:[{namePrefix:"uBit"}], optionalServices: [SERVICE_UUID]});
        let server = await device.gatt.connect()
        let services = await server.getPrimaryServices() 
        services = services.filter( u => u.uuid == SERVICE_UUID)
        if(services.length>0) {
            let service = services[0]
            let chars = await service.getCharacteristics()  
            // Add or update the device
            let uB = this.devices.get(device.id)
            if(!uB){
                uB = new uBit(this)
                this.devices.set(device.id, uB)
            }
            await uB.onConnect(service, chars, device)
        } else {
            await uB.devices.gatt.disconnect()
            console.warn("No service found!")
        } 
    }

    /**
     * 
     * @returns Get Map of all devices (that have been connected to in the past)
     */
    getDevices() {
        return new Map(this.devices)
    }

}



