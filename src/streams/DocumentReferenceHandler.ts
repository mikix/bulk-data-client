import { extname }                                from "path"
import { Readable, Transform }                    from "stream"
import { URL }                                    from "url"
import jose                                       from "node-jose"
import { OptionsOfUnknownResponseBody, Response } from "got/dist/source"
import PDF                                        from "../lib/PDF"
import { FileDownloadError }                      from "../lib/errors"
import { wait }                                   from "../lib/utils"


export interface DocumentReferenceHandlerOptions {
    downloadAttachments: boolean
    inlineAttachments: number
    inlineAttachmentTypes: string[]
    pdfToText: boolean
    baseUrl: string
    request: <T=unknown>(options: OptionsOfUnknownResponseBody) => Promise<Response<T>>
    save: (fileName: string, stream: Readable, subFolder: string) => Promise<any>
    onDownloadComplete: (url: string, buteSize: number) => void
}

async function pdfToText(data: Buffer) {
    const text = await PDF.getPDFText({ data });
    return Buffer.from(text);
}

/**
 * This is a transform stream that will do the following:
 * 1. Validate incoming object and verify that they have `resourceType` and `id`
 * 2. If resources are not "DocumentReference" pass them through
 * 3. If resources are "DocumentReference" having `content[0].attachment.url`:
 *    - Schedule another download for that url
 *    - Save the file under unique name to avoid duplicate conflicts
 *    - Modify content[0].attachment.url to use the downloaded file path
 */
export default class DocumentReferenceHandler extends Transform
{
    private options: DocumentReferenceHandlerOptions;

    constructor(options: DocumentReferenceHandlerOptions)
    {
        super({
            readableObjectMode: true,
            writableObjectMode: true
        });

        this.options = options;
    }

    private async downloadAttachment(attachment: fhir4.Attachment): Promise<{ contentType: string; data: Buffer }> {

        if (!attachment.url) {
            throw new Error("DocumentReferenceHandler.downloadAttachment called on attachment that has no 'url'")
        }

        // If the url is relative then convert it to absolute on the same base
        const url = new URL(attachment.url, this.options.baseUrl)

        const res = await this.options.request<Buffer>({
            url,
            responseType: "buffer",
            throwHttpErrors: false,
            headers: {
                accept: attachment.contentType || "application/json+fhir"
            }
        })

        if (res.statusCode >= 400) {
            throw new FileDownloadError({
                fileUrl: attachment.url,
                body   : null,
                code   : res.statusCode
            });
        }

        const contentType = res.headers["content-type"] || "";

        // We may have gotten back a Binary FHIR resource
        if (contentType.match(/\bapplication\/json(\+fhir)?\b/)) {
            const json = JSON.parse(res.body.toString("utf8"));
            const { resourceType, contentType, data } = json;
            if (resourceType === "Binary") {
                const buffer = Buffer.from(data, "base64")
                this.options.onDownloadComplete(attachment.url, buffer.byteLength)
                return { contentType, data: buffer }
            }
        }

        this.options.onDownloadComplete(attachment.url, res.body.byteLength)

        return {
            contentType: contentType || attachment.contentType || "",
            data       : res.body
        }
    }

    private async downloadAttachmentWithRetries(attachment: fhir4.Attachment): Promise<{ contentType: string; data: Buffer }> {
        for (const i of [1, 2, 3, 4]) {
            try {
                return await this.downloadAttachment(attachment)
            }
            catch (err: any) {
                if (err instanceof FileDownloadError) {
                  const urlFragment = attachment.url && attachment.url.replace(this.options.baseUrl, "")
                  console.log("MIKE: error " + err.code + " for " + urlFragment);
                  // don't bother retrying generic 500 errors, that's usually a reliable server error
                  if (err.code === 500 || err.code === 422) {
                    throw err
                  } else {
                    await wait(5000)
                  }
                } else {
                  console.log("MIKE: unknown error happened: " + err)
                  throw err // don't bother retrying oddball errors
                }
            }
        }
        return await this.downloadAttachment(attachment)
    }

    private async inlineAttachmentData(node: fhir4.Attachment, data: Buffer) {
        if (node.contentType == "application/pdf" && this.options.pdfToText) {
            data = await pdfToText(data);
            node.contentType = "text/plain"
        }
        node.size = data.byteLength
        node.data = data.toString("base64")
        delete node.url
        return node
    }

    private async handleAttachmentReferences(resource: fhir4.DocumentReference): Promise<fhir4.DocumentReference>
    {
        for (const entry of resource.content || []) {
            const attachment = entry.attachment;

            if (!attachment.url) {
                continue;
            }

            const maybeInline = !attachment.contentType || this.canPutContentTypeInline(attachment.contentType)
            const shouldDownload = this.options.downloadAttachments === true
            const shouldFetch = maybeInline || shouldDownload
            if (!shouldFetch) {
                continue
            }

            let response
            try {
                response = await this.downloadAttachmentWithRetries(attachment)
            } catch (err) {
                continue
            }

            // Re-check if we can inline this attachment, now that we know the size of the data
            // and the server-provided content type.
            if (this.canPutAttachmentInline(response.data, response.contentType)) {
                await this.inlineAttachmentData(attachment, response.data);
            }
            
            else if (shouldDownload) {
                const fileName = Date.now() + "-" + jose.util.randomBytes(6).toString("hex") + extname(attachment.url);
                await this.options.save(
                    fileName,
                    Readable.from(response.data),
                    "attachments"
                )
                attachment.url = `./attachments/${fileName}`
            }
            else {
                continue
            }
            this.emit("attachment")
        }

        return resource;
    }

    canPutContentTypeInline(contentType: string): boolean
    {
        if (!contentType) {
            return false
        }

        if (!this.options.inlineAttachmentTypes.find(m => contentType.startsWith(m))) {
            return false
        }

        return true
    }

    canPutAttachmentInline(data: Buffer, contentType: string): boolean
    {
        if (data.byteLength > this.options.inlineAttachments) {
            return false
        }

        if (!this.canPutContentTypeInline(contentType)) {
            return false
        }

        return true
    }

    override _transform(
        resource: fhir4.DocumentReference,
        encoding: any,
        callback: (err: Error | null, chunk?: fhir4.Resource) => any
    )
    {
        if (resource.resourceType != "DocumentReference") {
            return callback(null, resource)
        }
        else {
            this.handleAttachmentReferences(resource).then(
                res => callback(null, res),
                err => callback(err)
            )
        }
    }
}
