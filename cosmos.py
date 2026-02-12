from azure.cosmos import (
    CosmosClient,
    PartitionKey,
    ThroughputProperties,
    ContainerProxy,
    exceptions,
)

from azure.identity import DefaultAzureCredential

import time, os

endpoint = os.environ.get("COSMOS_ENDPOINT")
key = os.environ.get("COSMOS_KEY")
db = os.environ.get("COSMOS_DB")
container_name = os.environ.get("COSMOS_CONTAINER")


client = CosmosClient(endpoint, key)

database = client.get_database_client(db)
container = database.get_container_client(container_name)

def add_order(order_doc):
    try:
        container.create_item(body=order_doc["order"])
        print("Order added successfully.")
    except exceptions.CosmosHttpResponseError as e:
        print(f"An error occurred: {e.message}")

