
Copyright 2026 Google LLC.

# @title Licensed under the Apache License, Version 2.0 (the "License");
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     https://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

     
File Search Quickstart


The File Search tool allows you to build powerful retrieval-augmented generation (RAG) applications using Gemini. It lets you upload documents to a managed store and then use them as a tool during model generation, enabling Gemini to answer questions based on your specific data with accurate citations.

In this quickstart, you will learn how to:

Create a File Search Store.
Upload documents to the store.
Use the store as a tool in generate_content.
Cite the sources used during generation.
Filter search results using custom metadata.
Manage your documents and stores.
For information on how pricing works for File Search, including details on what is available free of charge, see the pricing information.

Install dependencies
First, install the Google Gen AI SDK.


# SDK 1.49 introduced File Search
%pip install -U -q 'google-genai>=1.49.0'
     
Authentication
Important: The File Search API uses API keys for authentication and access. Uploaded files are associated with the API key's cloud project. Unlike other Gemini APIs that use API keys, your API key also grants access to all data you've uploaded to file stores, so take extra care in keeping your API key secure. For best practices on securing API keys, refer to Google's documentation.

Set up your API key
To run the following cell, your API key must be stored in a Colab Secret named GEMINI_API_KEY. If you don't already have an API key, or you're not sure how to create a Colab Secret, see Authentication for an example.


from google import genai
from google.colab import userdata
from google.genai import types

GEMINI_API_KEY = userdata.get("GEMINI_API_KEY")
client = genai.Client(api_key=GEMINI_API_KEY)
     
Basic file search
In this section, you will download a sample document, create a File Search Store, and use it to answer questions.

Create a File Search Store
Create a new File Search Store to hold your documents.


file_search_store = client.file_search_stores.create(
    config=types.CreateFileSearchStoreConfig(
        display_name='My File Search Store'
    )
)

print(f"Created store: {file_search_store.name}")
     
Created store: fileSearchStores/my-file-search-store-9fimh45e9q14
Download a sample document
Download "A Survey of Modernist Poetry" from Project Gutenberg as a sample text file.


!wget -q https://www.gutenberg.org/cache/epub/76401/pg76401.txt -O sample_poetry.txt
!head sample_poetry.txt
     
﻿The Project Gutenberg eBook of A survey of modernist poetry
    
This ebook is for the use of anyone anywhere in the United States and
most other parts of the world at no cost and with almost no restrictions
whatsoever. You may copy it, give it away or re-use it under the terms
of the Project Gutenberg License included with this ebook or online
at www.gutenberg.org. If you are not located in the United States,
you will have to check the laws of the country where you are located
before using this eBook.

Upload a file to the store
Upload the text file directly to the store. The ingestion process includes some processing, so you need to wait for it to complete before you can search.


import time

upload_op = client.file_search_stores.upload_to_file_search_store(
    file_search_store_name=file_search_store.name,
    file='sample_poetry.txt',
    config=types.UploadToFileSearchStoreConfig(
        display_name='A Survey of Modernist Poetry',
    )
)

print(f"Upload started: {upload_op.name}")


while not (upload_op := client.operations.get(upload_op)).done:
    time.sleep(1)
    print(".", end="")

print()
print("Processing complete.")
     
Upload started: fileSearchStores/my-file-search-store-9fimh45e9q14/upload/operations/a-survey-of-modernist-poetr-rd7al7895r59
...
Processing complete.
Alternative: Import from the File API
If you have already uploaded documents to the File API, you can import them directly into a File Store. This may be helpful if a user has performed some interaction with a file already, such as generating a summary, and has approved the file for use in a store.


file_ref = client.files.upload(
    file='sample_poetry.txt',
    config=types.UploadFileConfig(
        display_name='A Survey of Modernist Poetry',
        mime_type='text/plain',
    )
)
print(f"Uploaded via File API: {file_ref.name}")

import_op = client.file_search_stores.import_file(
    file_search_store_name=file_search_store.name,
    file_name=file_ref.name,
)

print(f"File import started: {import_op.name}")

while not (import_op := client.operations.get(import_op)).done:
    time.sleep(1)
    print(".", end="")

print()
print("Processing complete.")
     
Uploaded via File API: files/li0pn1it912i
File import started: fileSearchStores/my-file-search-store-9fimh45e9q14/operations/li0pn1it912i-ucqsutd9emb1
....
Processing complete.
Generate content with File Search
Now, use the file_search tool in a generate_content request. Gemini will use the uploaded document to answer your question.


MODEL_ID = "gemini-3-flash-preview" # @param ["gemini-2.5-flash-lite", "gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.5-flash-preview", "gemini-3-pro-preview"] {"allow-input":true, isTemplate: true}

response = client.models.generate_content(
    model=MODEL_ID,
    contents='What does the text say about E.E. Cummings?',
    config=types.GenerateContentConfig(
        tools=[types.Tool(
            file_search=types.FileSearch(
                file_search_store_names=[file_search_store.name],
            )
        )]
    )
)

print(response.text)
     
The text discusses E.E. Cummings as a significant poet whose work demands a "more vigorous imaginative effort" from the reader than what is typically applied to poetry. His innovations are considered to have a real place in the normal course of poetry-writing, and his acceptance is suggested, if not for his own sake, then for his potential effect on the future reading of poetry of any age or style.

One of Cummings' earlier and simpler poems is chosen for analysis in the text, despite its potential to elicit hostility similar to his later work. This particular poem is noted for its suitability for analysis, as it addresses a subject matter that the "plain reader" often seeks in poetry. It also appears in Mr. Louis Untermeyer's "Anthology of Modern American Poetry" alongside poets who are more willing to cater to the plain reader's intelligence level.

The text further suggests that Cummings writes according to a carefully constructed poetic system, but he refrains from providing a critical key to his poems, except as a "semi-prefatorial confidence." This implies that as poems become more independent, the need or sense for a technical guide diminishes. The increasing difficulty of poems would not necessarily hinder understanding but rather make the reader less separated from poetry by technique.

Regarding his use of punctuation, the text describes punctuation marks in Cummings' poetry as "bolts and axels" that make the poem a "methodic and fool-proof piece of machinery" that requires common sense rather than imagination for its operation. The strong reaction against his typography highlights the difficulty in engaging a reader's common sense as much as their imagination.

The text concludes by suggesting that while future poems might not all be written "in the Cummings way," his poetry is important as a "sign of local irritation in the poetic body" rather than a model for a new tradition. It emphasizes the need to highlight the differences between good and bad poems to the reading public, especially during a time of popular but superficial education.
Additional fields
The FileSearch tool provides some options for configuring how the tool works, top_k and metadata_filter.

top_k controls how many chunks will be returned from the search tool and passed to the generation step. This is the same example as before, but only 1 chunk will be used to generate the answer. This control can be helpful to guide the model if you know there is only one correct chunk to consider (k=1), or if you expect the chunks to have more overlap and you want to include more context (higher top_k).

Metadata filtering is described in the next section, and you can find the full spec in the API reference.


top_K = 1 # @param {"allow-input":true, isTemplate: true}

response = client.models.generate_content(
    model=MODEL_ID,
    contents='What does the text say about E.E. Cummings?',
    config=types.GenerateContentConfig(
        tools=[types.Tool(
            file_search=types.FileSearch(
                file_search_store_names=[file_search_store.name],
                top_k=top_K,
            )
        )]
    )
)

print(response.text)
     
Inspect grounding metadata
The response includes grounding_metadata which contains citations and references to the source document. The document chunks used in the generation context are available in grounding_metadata.grounding_chunks, and look like this.

[
  GroundingChunk(
    retrieved_context=GroundingChunkRetrievedContext(
      text="""(the snippet of text contained in this chunk)""",
      title='(the title of the document)'
    )
  ), ...
]

import textwrap

grounding = response.candidates[0].grounding_metadata

if grounding and grounding.grounding_chunks:
    print(f"Found {len(grounding.grounding_chunks)} grounding chunks.")
    for i, chunk in enumerate(grounding.grounding_chunks, start=1):
        print(f"\nChunk {i} source: {chunk.retrieved_context.title}")
        print("Chunk text:")
        print(textwrap.indent(chunk.retrieved_context.text[:150] + "...", "  "))
else:
    print("No grounding metadata found.")
     
Found 5 grounding chunks.

Chunk 1 source: A Survey of Modernist Poetry
Chunk text:
  alterations in his critical
  attitude. In the first place, he must admit that what is called our
  common intelligence is the mind in its least active ...

Chunk 2 source: A Survey of Modernist Poetry
Chunk text:
  unusually suitable for analysis,
  because it is on just the kind of subject that the plain reader
  looks for in poetry. It appears, moreover, in Mr. L...

Chunk 3 source: A Survey of Modernist Poetry
Chunk text:
  4th of July the eyes of mice and Niagara
   Falls) that my “poems” are competing. They are also competing with
   each other, with elephants and with El...

Chunk 4 source: A Survey of Modernist Poetry
Chunk text:
  Mr. Cummings or for any poet to stabilize a poem once and
  for all. Punctuation marks in Mr. Cummings’ poetry are the bolts and
  axels that make the p...

Chunk 5 source: A Survey of Modernist Poetry
Chunk text:
  and to
  put _dream_ in its more logical position, since in the original
  poem it is doing double duty for a specific image (_fishing-net_,
  following ...
Additionally, grounding_metadata includes grounding_supports that provide references from the response text to the supporting documents, and can be used for providing annotations.

The supports look like this.

[
  GroundingSupport(
    grounding_chunk_indices=[
      0,  # The index in `grounding_chunks` to which this corresponds
    ],
    segment=Segment(
      start_index=123,  # Indices into the generated text
      end_index=456,
      text='(the span of generated text being supported)'
    )
  ), ...
]

from IPython.display import Markdown, display

# Accumulate the response as it is annotated.
annotated_response_parts = []

if not grounding or not grounding.grounding_supports:
    print("No grounding metadata or supports found for annotation.")
else:
    cursor = 0
    for support in grounding.grounding_supports:
        # Add the text before the current support
        annotated_response_parts.append(response.text[cursor:support.segment.start_index])

        # Construct the superscript citation from chunk IDs
        chunk_ids = ', '.join(map(str, support.grounding_chunk_indices))
        citation = f"{chunk_ids}"

        # Append the formatted, cited, supported text
        annotated_response_parts.append(f"**{support.segment.text}**{citation}")

        cursor = support.segment.end_index

    # Append any remaining text after the last support
    annotated_response_parts.append(response.text[cursor:])

    final_annotated_response = "".join(annotated_response_parts)
    display(Markdown(final_annotated_response))

     
The text discusses E.E. Cummings as a significant poet whose work demands a "more vigorous imaginative effort" from the reader than what is typically applied to poetry. His innovations are considered to have a real place in the normal course of poetry-writing, and his acceptance is suggested, if not for his own sake, then for his potential effect on the future reading of poetry of any age or style0.

One of Cummings' earlier and simpler poems is chosen for analysis in the text, despite its potential to elicit hostility similar to his later work. This particular poem is noted for its suitability for analysis, as it addresses a subject matter that the "plain reader" often seeks in poetry. It also appears in Mr. Louis Untermeyer's "Anthology of Modern American Poetry" alongside poets who are more willing to cater to the plain reader's intelligence level0, 1.

The text further suggests that Cummings writes according to a carefully constructed poetic system, but he refrains from providing a critical key to his poems, except as a "semi-prefatorial confidence." This implies that as poems become more independent, the need or sense for a technical guide diminishes. The increasing difficulty of poems would not necessarily hinder understanding but rather make the reader less separated from poetry by technique2.

Regarding his use of punctuation, the text describes punctuation marks in Cummings' poetry as "bolts and axels" that make the poem a "methodic and fool-proof piece of machinery" that requires common sense rather than imagination for its operation. The strong reaction against his typography highlights the difficulty in engaging a reader's common sense as much as their imagination3.

The text concludes by suggesting that while future poems might not all be written "in the Cummings way," his poetry is important as a "sign of local irritation in the poetic body" rather than a model for a new tradition. It emphasizes the need to highlight the differences between good and bad poems to the reading public, especially during a time of popular but superficial education4.

Metadata Filtering
While adding documents, you can attach custom metadata to your files and use it to filter search results.

Upload a file with metadata
Download another book, "Alice's Adventures in Wonderland", and upload it with information about genre and author.


!wget -q https://www.gutenberg.org/files/11/11-0.txt -O alice_in_wonderland.txt
!head alice_in_wonderland.txt
     
*** START OF THE PROJECT GUTENBERG EBOOK 11 ***

[Illustration]




Alice’s Adventures in Wonderland

by Lewis Carroll

upload_op = client.file_search_stores.upload_to_file_search_store(
    file_search_store_name=file_search_store.name,
    file='alice_in_wonderland.txt',
    config=types.UploadToFileSearchStoreConfig(
        display_name='Alice in Wonderland',
        custom_metadata=[
            types.CustomMetadata(key='genre', string_value='fiction'),
            types.CustomMetadata(key='author', string_value='Lewis Carroll'),
        ]
    )
)

while not (upload_op := client.operations.get(upload_op)).done:
    time.sleep(1)
    print(".", end="")

print()
print("Upload complete.")
     
..
Upload complete.
Custom metadata can be provided as string_value, numeric_value or string_list_value types.


types.CustomMetadata.model_fields.keys() - {'key'}
     
{'numeric_value', 'string_list_value', 'string_value'}
Query with metadata filter
Now, ask a question that could apply to either book, but use a filter to restrict it to just one. For example, ask about a "Queen" but filter for 'fiction'.


response = client.models.generate_content(
    model=MODEL_ID,
    contents='Who is the Queen?',
    config=types.GenerateContentConfig(
        tools=[types.Tool(
            file_search=types.FileSearch(
                file_search_store_names=[file_search_store.name],
                metadata_filter='genre = "fiction"'
            )
        )]
    )
)

print(response.text)
print('-' * 80)

if grounding := response.candidates[0].grounding_metadata:
  unique_titles = {c.retrieved_context.title for c in grounding.grounding_chunks}
  print(len(grounding.grounding_chunks), "sources used from", *unique_titles)
else:
  print("No sources used.")
     
Based on the information available, "the Queen" refers to the Queen of Hearts from Lewis Carroll's *Alice in Wonderland*. She is depicted as a tyrannical ruler who frequently shouts "Off with his head!" or "Off with her head!". She is known for her severe demeanor and short temper. For instance, she becomes crimson with fury when Alice responds surprisingly to her questions. The Queen is part of a grand procession alongside the King of Hearts, with soldiers and courtiers accompanying them. She is often seen playing croquet and sentencing players to execution.
--------------------------------------------------------------------------------
5 sources used from Alice in Wonderland
To learn more about how to build complex filters, read the AIP-160 spec.

Managing Documents
You can also manage individual documents within a store.

List documents
List all documents currently in the store.


print(f"Documents in {file_search_store.name}:")

for doc in client.file_search_stores.documents.list(parent=file_search_store.name):
    print(f"- {doc.display_name} ({doc.name})")
     
Documents in fileSearchStores/my-file-search-store-9fimh45e9q14:
- A Survey of Modernist Poetry (fileSearchStores/my-file-search-store-9fimh45e9q14/documents/a-survey-of-modernist-poetr-rd7al7895r59)
- li0pn1it912i (fileSearchStores/my-file-search-store-9fimh45e9q14/documents/li0pn1it912i-ucqsutd9emb1)
Get a document
Retrieve details for a specific document, such as its processing status or metadata.


# Get a document by ID
doc_id = doc.name  # Or set a specific ID here.
sample_doc = client.file_search_stores.documents.get(name=doc_id)

if sample_doc:
    print(f"Document details for {sample_doc.display_name}:")
    print(f"  Name: {sample_doc.name}")
    print(f"  Custom Metadata: {sample_doc.custom_metadata}")
     
Document details for li0pn1it912i:
  Name: fileSearchStores/my-file-search-store-9fimh45e9q14/documents/li0pn1it912i-ucqsutd9emb1
  Custom Metadata: None
Delete a document
Remove a specific document from the store without deleting the entire store.


# Delete a specific document.
doc_to_be_deleted = doc_id

client.file_search_stores.documents.delete(
    name=doc_to_be_deleted,
    config=types.DeleteDocumentConfig(
        # Set force to delete a non-empty document.
        force=True
    )
)
print(f"Deleted document: {doc_to_be_deleted}")

# Verify deletion
print("\nRemaining documents:")
for doc in client.file_search_stores.documents.list(parent=file_search_store.name):
    print(f"- {doc.display_name}")
     
Deleted document: fileSearchStores/my-file-search-store-9fimh45e9q14/documents/li0pn1it912i-ucqsutd9emb1

Remaining documents:
- A Survey of Modernist Poetry
Managing File Search Stores
You can list, get, and delete your File Search Stores.


print("Stores:")

for store in client.file_search_stores.list():
    print(f"- {store.name} ({store.display_name})")
     
Listing stores:
- fileSearchStores/my-file-search-store-9fimh45e9q14 (My File Search Store)
Cleanup
It's good practice to delete File Search Stores when you are done with them to avoid unnecessary storage costs.


client.file_search_stores.delete(name=file_search_store.name, config=types.DeleteFileSearchStoreConfig(force=True))
print(f"Deleted store: {file_search_store.name}")
     
What's next
For more information on the File Search tool, be sure to check these out.

The File Search guide
Pricing information
The detailed API reference
The File API cookbook